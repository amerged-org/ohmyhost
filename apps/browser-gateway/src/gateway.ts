import { PDFDocument } from "pdf-lib";
import {
  BROWSER_HTML_MAX_BYTES,
  BROWSER_KEY_PATTERN,
  BROWSER_MAX_MS,
  BROWSER_MAX_PAGES,
  BROWSER_PDF_MAX_BYTES,
  normalizeBrowserDuration,
  type BrowserBillingScope,
  type BrowserGatewayRuntime,
  type BrowserKeyScope,
} from "@ohmyhost/platform";

/** The provider only receives these fixed options, not customer-supplied Browser Run controls. */
export interface BrowserPdfOptions {
  readonly html: string;
  readonly cacheTTL: 0;
  readonly setJavaScriptEnabled: false;
  readonly allowRequestPattern: ["^data:"];
  readonly gotoOptions: { readonly timeout: number };
  readonly actionTimeout: number;
  readonly pdfOptions: {
    readonly timeout: number;
    readonly printBackground: true;
    readonly preferCSSPageSize: true;
  };
}
export interface BrowserBinding {
  quickAction(action: "pdf", options: BrowserPdfOptions): Promise<Response>;
}
export interface Limiter {
  limit(input: { key: string }): Promise<{ success: boolean }>;
}
export interface WaitUntilContext {
  waitUntil(promise: Promise<unknown>): void;
}
export interface BrowserGatewayOptions {
  readonly runtime: BrowserGatewayRuntime;
  readonly browser: BrowserBinding;
  readonly journal: {
    record(input: {
      scope: BrowserBillingScope;
      reservationId: string;
      browserMs: string | null;
    }): Promise<void>;
  };
  readonly limiter: Limiter;
  readonly authLimiter: Limiter;
  readonly newReservationId: () => string;
}
export interface BrowserGateway {
  fetch(request: Request, ctx?: WaitUntilContext): Promise<Response>;
  scheduled(): Promise<void>;
}

// Resource hints and nested browsing contexts can initiate work outside ordinary subresource interception.
// This deliberately conservative test may also reject matching text in comments or attribute values.
const UNSUPPORTED_HTML_TAG =
  /<\s*(?:\/\s*)?(?:link|base|iframe|frame|object|embed|portal|fencedframe)(?=[\s/>])/iu;
const JSON_MAX_BYTES = BROWSER_HTML_MAX_BYTES * 6 + 64;
const READ_TIMEOUT_MS = 30_000;
const SWEEP_OLDER_THAN_MS = 15 * 60_000;
const SWEEP_LIMIT = 200;

class Failure extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}
function error(status: number, code: string): Response {
  return Response.json({ error: { code } }, { status, headers: { "cache-control": "no-store" } });
}
async function boundedRpc<T>(call: () => Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      call(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("browser RPC timeout")), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
async function digest(value: string): Promise<string> {
  const bytes = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  );
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
/** Read only to a strict byte bound, including chunked bodies without Content-Length. */
async function bounded(
  body: ReadableStream<Uint8Array> | null,
  max: number,
  timeoutMs = READ_TIMEOUT_MS,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  if (body === null) return new Uint8Array();
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let timedOut = false;
  const stop = () => {
    timedOut = true;
    void reader.cancel().catch(() => undefined);
  };
  const timer = setTimeout(stop, Math.max(0, timeoutMs));
  signal?.addEventListener("abort", stop, { once: true });
  if (signal?.aborted) stop();
  try {
    while (true) {
      const part = await reader.read();
      if (timedOut)
        throw new Failure(
          signal?.aborted ? 499 : 504,
          signal?.aborted ? "client_aborted" : "browser_timeout",
        );
      if (part.done) break;
      total += part.value.byteLength;
      if (total > max) {
        void reader.cancel().catch(() => undefined);
        throw new Failure(413, "body_too_large");
      }
      chunks.push(part.value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", stop);
    reader.releaseLock();
  }
}
async function readHtml(request: Request, deadline: number): Promise<string> {
  if (!/^application\/json(?:\s*;|$)/iu.test(request.headers.get("content-type") ?? ""))
    throw new Failure(415, "content_type_unsupported");
  const length = request.headers.get("content-length");
  if (length !== null && Number(length) > JSON_MAX_BYTES) throw new Failure(413, "body_too_large");
  const bytes = await bounded(request.body, JSON_MAX_BYTES, deadline - Date.now(), request.signal);
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new Failure(400, "invalid_request");
  }
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).length !== 1 ||
    typeof Reflect.get(value, "html") !== "string"
  )
    throw new Failure(400, "invalid_request");
  const html = Reflect.get(value, "html") as string;
  if (new TextEncoder().encode(html).byteLength > BROWSER_HTML_MAX_BYTES)
    throw new Failure(413, "html_too_large");
  if (UNSUPPORTED_HTML_TAG.test(html)) throw new Failure(400, "unsupported_html_tag");
  return html;
}
/** Bound memory before reading untrusted bodies, and protect a second tenant from one stalled tenant. */
const CAPACITY_LEASE_MS = 65_000;
const inFlight = new Map<symbol, { organizationId: string; expiresAt: number }>();
function acquire(organizationId: string): () => void {
  const now = Date.now();
  for (const [token, lease] of inFlight) if (lease.expiresAt <= now) inFlight.delete(token);
  let organizationCount = 0;
  for (const lease of inFlight.values())
    if (lease.organizationId === organizationId) organizationCount++;
  if (inFlight.size >= 4 || organizationCount >= 2) throw new Failure(503, "browser_unavailable");
  const token = Symbol("browser-capacity");
  inFlight.set(token, { organizationId, expiresAt: now + CAPACITY_LEASE_MS });
  return () => {
    inFlight.delete(token);
  };
}

function measuredMs(headers: Headers): string | null {
  const value = headers.get("x-browser-ms-used");
  return value === null ? null : normalizeBrowserDuration(value);
}
function billingScope(scope: BrowserKeyScope): BrowserBillingScope {
  return {
    organizationId: scope.organizationId,
    projectId: scope.projectId,
    environmentId: scope.environmentId,
  };
}

export function createBrowserGateway({
  runtime,
  browser,
  journal,
  limiter,
  authLimiter,
  newReservationId,
}: BrowserGatewayOptions): BrowserGateway {
  async function authorize(request: Request): Promise<BrowserKeyScope> {
    const key = /^Bearer /iu.test(request.headers.get("authorization") ?? "")
      ? (request.headers.get("authorization") ?? "").slice(7)
      : "";
    const projectId = BROWSER_KEY_PATTERN.exec(key)?.[1];
    if (projectId === undefined) throw new Failure(401, "invalid_api_key");
    if (
      !(await authLimiter.limit({ key: request.headers.get("cf-connecting-ip") ?? "unknown" }))
        .success
    )
      throw new Failure(429, "browser_rate_limited");
    const scope = await runtime.authorizeKey({ projectId, keySha256: await digest(key) });
    if (scope === null) throw new Failure(401, "invalid_api_key");
    if (!(await limiter.limit({ key: scope.projectId })).success)
      throw new Failure(429, "browser_rate_limited");
    return scope;
  }
  async function settle(
    scope: BrowserKeyScope,
    reservationId: string,
    browserMs: string | null,
  ): Promise<void> {
    // Start both independent writes immediately: a late header must not wait on a hung journal before trying Core.
    const journalAttempt = boundedRpc(
      () => journal.record({ scope: billingScope(scope), reservationId, browserMs }),
      5_000,
    ).then(
      () => true,
      () => false,
    );
    const coreAttempt = (async () => {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const result = await boundedRpc(
            () => runtime.settle({ scope: billingScope(scope), reservationId, browserMs }),
            5_000,
          );
          if (result.settled || result.reason === "already_resolved") return true;
          break;
        } catch {
          /* A retry has the same idempotent reservation identity. */
        }
      }
      return false;
    })();
    if (await coreAttempt) return;
    const journaled = await journalAttempt;
    if (!journaled)
      console.warn(
        JSON.stringify({ event: "browser_measurement_unconfirmed", reservationId, browserMs }),
      );
    throw new Failure(503, "browser_unavailable");
  }
  async function render(
    scope: BrowserKeyScope,
    reservationId: string,
    html: string,
    providerPhaseTimeout: number,
  ): Promise<Response> {
    let response: Response;
    try {
      response = await browser.quickAction("pdf", {
        html,
        cacheTTL: 0,
        setJavaScriptEnabled: false,
        allowRequestPattern: ["^data:"],
        gotoOptions: { timeout: providerPhaseTimeout },
        actionTimeout: providerPhaseTimeout,
        pdfOptions: {
          timeout: providerPhaseTimeout,
          printBackground: true,
          preferCSSPageSize: true,
        },
      });
    } catch {
      await settle(scope, reservationId, null);
      return error(502, "browser_provider_failed");
    }
    // Account for measured work on success and failure alike; never retain provider bodies or error messages.
    try {
      await settle(scope, reservationId, measuredMs(response.headers));
    } catch (cause) {
      void response.body?.cancel().catch(() => undefined);
      throw cause;
    }
    if (!response.ok) {
      void response.body?.cancel().catch(() => undefined);
      return error(502, "browser_provider_failed");
    }
    let bytes: Uint8Array;
    try {
      bytes = await bounded(response.body, BROWSER_PDF_MAX_BYTES);
    } catch {
      return error(502, "browser_pdf_too_large");
    }
    try {
      // pdf-lib is pinned and patched to suppress parser diagnostics containing customer data.
      const document = await PDFDocument.load(bytes, {
        throwOnInvalidObject: true,
        updateMetadata: false,
      });
      if (document.getPageCount() > BROWSER_MAX_PAGES)
        return error(422, "browser_page_limit_exceeded");
      if (document.getPageCount() < 1) return error(502, "browser_invalid_pdf");
    } catch {
      return error(502, "browser_invalid_pdf");
    }
    return new Response(Uint8Array.from(bytes).buffer, {
      status: 200,
      headers: {
        "content-type": "application/pdf",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
    });
  }
  async function releaseUndispatched(scope: BrowserKeyScope, reservationId: string): Promise<void> {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await runtime.release({
          scope: billingScope(scope),
          reservationId,
          reason: "client_aborted",
        });
        return;
      } catch {
        /* A lost admission/release answer is retried with the same identity; the sweep is the backstop. */
      }
    }
  }
  async function fetchRequest(request: Request, ctx?: WaitUntilContext): Promise<Response> {
    const deadline = Date.now() + BROWSER_MAX_MS;
    let timedOut = false;
    const stopped = () => timedOut || request.signal.aborted || Date.now() >= deadline;
    const check = () => {
      if (stopped())
        throw new Failure(
          request.signal.aborted ? 499 : 504,
          request.signal.aborted ? "client_aborted" : "browser_timeout",
        );
    };
    const work = (async (): Promise<Response> => {
      try {
        const url = new URL(request.url);
        if (request.method !== "POST" || url.pathname !== "/v1/pdf" || url.search !== "")
          return error(404, "not_found");
        check();
        const scope = await authorize(request);
        check();
        const releaseCapacity = acquire(scope.organizationId);
        try {
          const html = await readHtml(request, deadline);
          check();
          const reservationId = newReservationId();
          let admitted;
          try {
            admitted = await runtime.admit({ scope, reservationId });
          } catch {
            // Resolve a possibly committed admission by replaying the same reservation identity, then release it.
            try {
              await runtime.admit({ scope, reservationId });
            } catch {
              /* Sweep remains the last backstop. */
            }
            await releaseUndispatched(scope, reservationId);
            throw new Failure(503, "browser_unavailable");
          }
          if (!admitted.admitted) {
            const status =
              admitted.denial === "unavailable"
                ? 503
                : admitted.denial === "too_many_open_calls"
                  ? 429
                  : 402;
            return error(status, admitted.denial);
          }
          const providerPhaseTimeout = Math.min(15_000, Math.floor((deadline - Date.now()) / 2));
          if (stopped() || providerPhaseTimeout < 1) {
            await releaseUndispatched(scope, reservationId);
            throw new Failure(
              request.signal.aborted ? 499 : 504,
              request.signal.aborted ? "client_aborted" : "browser_timeout",
            );
          }
          // After dispatch, always resolve measured billing even when the caller has left.
          return await render(scope, reservationId, html, providerPhaseTimeout);
        } finally {
          releaseCapacity();
        }
      } catch (cause) {
        return cause instanceof Failure
          ? error(cause.status, cause.code)
          : error(503, "browser_unavailable");
      }
    })();
    ctx?.waitUntil(work.then(() => undefined));
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    try {
      const interrupt = new Promise<Response>((resolve) => {
        timer = setTimeout(
          () => {
            timedOut = true;
            resolve(error(504, "browser_timeout"));
          },
          Math.max(0, deadline - Date.now()),
        );
        onAbort = () => resolve(error(499, "client_aborted"));
        request.signal.addEventListener("abort", onAbort, { once: true });
        if (request.signal.aborted) onAbort();
      });
      return await Promise.race([work, interrupt]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (onAbort !== undefined) request.signal.removeEventListener("abort", onAbort);
    }
  }

  return {
    fetch: fetchRequest,
    async scheduled() {
      await runtime.sweep({ olderThanMs: SWEEP_OLDER_THAN_MS, limit: SWEEP_LIMIT });
    },
  };
}
