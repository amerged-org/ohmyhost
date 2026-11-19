import {
  AI_HOLD_NANO_USD,
  AI_KEY_PATTERN,
  AI_REALTIME_IDLE_MS,
  AI_REALTIME_MAX_MS,
  aiJsonHoldNanoUsd,
  isEuOnlyLocations,
  type AiAdmitResult,
  type AiDenial,
  type AiGatewayRuntime,
  type AiKeyScope,
  type AiReleaseInput,
  type AiSettleInput,
} from "@ohmyhost/platform";
import { warnLine } from "./log.js";
import {
  MODELS_PATH,
  OUTPUT_TOKEN_PATHS,
  POST_ROUTES,
  REALTIME_PATH,
  isRecord,
  parseJson,
  readCall,
  prepareCall,
  MemoryCapacityError,
  releaseCall,
  realtimeModelOf,
  type Call,
  type RouteKind,
} from "./request.js";
import { AiFailure, aiError, aiPassThrough, aiResponse, type AiErrorCode } from "./responses.js";
import { fetchTraceCostNanoUsd, type OrqEndpoint, type Wait } from "./orq-cost.js";
import {
  ENABLED_MODELS_BYTES,
  fetchEuModelIds,
  fetchModelLocations,
  withOrqJson,
} from "./orq-metadata.js";

/*
 * The AI gateway: a one-to-one proxy of orq.ai. A call is limited by client address, authenticates its project key,
 * is rate limited, is admitted by the Core (paid plan, stop budget, credit hold), is forwarded to orq with the
 * gateway's own key, and its answer is streamed back unchanged. The cost is the one orq recorded for the trace of the
 * answer, or USD 0.01 for an answered chat/Responses call with no usable cost. A refusal before an answer releases
 * the hold, and a settlement that keeps failing is left to the sweep.
 * Nothing of a prompt or an answer is logged, and the gateway holds no model catalog.
 */

/** Until the headers of a call arrive; a failed answer is read within it too. */
export const ORQ_TIMEOUT_MS = 120_000;
/** A streamed answer may stall this long between two chunks, and may run this long in all. */
export const STREAM_IDLE_MS = 60_000;
export const STREAM_MAX_MS = 600_000;
export const SWEEP_OLDER_THAN_MS = 15 * 60_000;
export const SWEEP_LIMIT = 200;
const SETTLE_RETRY_MS = 500;
/** Only answered chat/Responses calls without a usable recorded cost use this owner-approved USD 0.01 cost. */
const LLM_COST_FALLBACK_NANO_USD = 10_000_000n;
const RATE_LIMIT_RETRY_AFTER = "60";
/** The wait a customer is told when the workspace already runs its cap of unresolved calls. */
const OPEN_CALLS_RETRY_AFTER = "5";
const AI_UNAVAILABLE = "The AI gateway is unavailable right now.";
const UPSTREAM_UNAVAILABLE = "The AI provider could not complete the call.";
const RATE_LIMITED = "Too many calls for this project. Retry later.";
const REJECTED = "The provider rejected the request.";
const PUBLIC_PREFIX = "/v1";
/** The status of a call whose client left before the answer was returned (nginx's convention). */
const CLIENT_CLOSED_STATUS = 499;
/** An orq rejection message that names our workspace, credit, billing, budget, plan or key is never forwarded. */
const REJECTION_REDACTED =
  /workspace|credit|balance|billing|quota|budget|api[ _-]?key|sk-|org-|plan/iu;
/** The orq statuses that name a bad request: the customer gets the status with orq's message, cut to this length. */
const REJECTED_STATUSES: ReadonlySet<number> = new Set([400, 404, 413, 415, 422]);
const REJECTION_MESSAGE_MAX = 500;
/** The orq statuses that name our own orq account or key; the customer never sees orq's text. */
const ACCOUNT_STATUSES: ReadonlySet<number> = new Set([401, 402, 403]);
/** The longest orq trace id the Core accepts. */
const TRACE_ID_MAX = 256;

export interface WaitUntilContext {
  waitUntil(promise: Promise<unknown>): void;
}

export interface Limiter {
  limit(input: { key: string }): Promise<{ success: boolean }>;
}

export interface AiGatewayOptions {
  readonly runtime: AiGatewayRuntime;
  readonly orq: OrqEndpoint;
  /** Bounds the calls of one project; it runs after the key is authorized. */
  readonly limiter: Limiter;
  /**
   * Bounds the requests of one client address before the Core is asked. Unverified project ids never create
   * fresh buckets for one address.
   */
  readonly authLimiter: Limiter;
  readonly newReservationId: () => string;
  /** Waits between two trace-cost queries; a test replaces it with a recording fake. */
  readonly wait: Wait;
}

export interface AiGateway {
  fetch(request: Request, ctx: WaitUntilContext): Promise<Response>;
  scheduled(): Promise<void>;
}

/** Why the Core refused a call, as the customer sees it. */
const DENIALS: Record<
  AiDenial | "unavailable",
  { code: AiErrorCode; message: string; headers?: Readonly<Record<string, string>> }
> = {
  paid_plan_required: {
    code: "paid_plan_required",
    message: "This project needs a Paid plan to use AI.",
  },
  insufficient_organization_credits: {
    code: "insufficient_organization_credits",
    message: "The organization has not enough credit for this call.",
  },
  project_budget_exceeded: {
    code: "project_budget_exceeded",
    message: "The project has reached its stop budget.",
  },
  too_many_open_calls: {
    code: "ai_rate_limited",
    message: "Too many AI calls are running for this workspace. Retry in a moment.",
    headers: { "retry-after": OPEN_CALLS_RETRY_AFTER },
  },
  unavailable: { code: "ai_unavailable", message: AI_UNAVAILABLE },
};

/** An orq answer that did not succeed: its status, and its text when it could be read. */
interface OrqFailure {
  readonly kind: "failed";
  readonly status: number;
  readonly retryAfter: string | null;
  readonly text: string | null;
}

/**
 * An orq answer that succeeded: its status and content type, its trace id, and its body still unread. The timers
 * restart on every chunk and abort the orq request when the answer stalls or runs too long.
 */
interface OrqSuccess {
  readonly kind: "answered";
  readonly status: number;
  readonly contentType: string | null;
  readonly traceId: string | null;
  readonly body: ReadableStream<Uint8Array> | null;
  readonly timers: StreamTimers;
  /** Aborts the orq request, and with it the body, when the client leaves. */
  readonly abort: () => void;
}

type OrqReply = OrqFailure | OrqSuccess;

/** An orq answer that accepted the realtime upgrade: its trace id and the upstream socket, not yet accepted. */
interface OrqUpgrade {
  readonly kind: "upgraded";
  readonly traceId: string | null;
  readonly socket: WebSocket;
}

/** The state of a WebSocket once it is open, as the Workers runtime and the browser number it. */
const WEBSOCKET_OPEN = 1;
/** The close codes of a realtime session: a normal closure, a session that ended by its idle limit and a failed session. */
const NORMAL_CLOSE_CODE = 1000;
const IDLE_CLOSE_CODE = 1001;
const SESSION_ERROR_CODE = 1011;

interface StreamTimers {
  touch(): void;
  stop(): void;
}

function unavailable(operation: string): AiFailure {
  warnLine("ai_gateway_outcome", { outcome: "binding_unavailable", operation });
  return new AiFailure("ai_unavailable", AI_UNAVAILABLE);
}

function invalidKey(): AiFailure {
  return new AiFailure("invalid_api_key", "The API key is missing or not valid.");
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Registers one promise with the Worker that resolves when the returned function is called. */
function keepAlive(ctx: WaitUntilContext): () => void {
  let resolveDone!: () => void;
  ctx.waitUntil(new Promise<void>((resolve) => (resolveDone = resolve)));
  return resolveDone;
}

function isSuccess(status: number): boolean {
  return status >= 200 && status < 300;
}

/** Random lowercase hex of `bytes` bytes: a W3C trace id is 16 bytes, a parent span id 8 bytes. */
function randomHex(bytes: number): string {
  return [...crypto.getRandomValues(new Uint8Array(bytes))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/** The trace id when the Core can store it, otherwise `null`: a longer id would fail every settlement. */
function traceIdOf(value: string | null): string | null {
  return value !== null && value.length > 0 && value.length <= TRACE_ID_MAX ? value : null;
}

/**
 * The close code a peer's close event is passed on with. The Workers runtime refuses close() with a code below 1000 or
 * above 4999 and with the reserved codes 1004, 1005, 1006 and 1015 (measured in workerd on 15 November 2026; 1001 and
 * 1011 are accepted): no status becomes a normal closure, and an abnormal, TLS, reserved or invalid code becomes an
 * internal error.
 */
function sendableCode(code: number): number {
  if (code === 1005) return NORMAL_CLOSE_CODE;
  if (code < 1000 || code > 4999 || code === 1004 || code === 1006 || code === 1015)
    return SESSION_ERROR_CODE;
  return code;
}

function retryAfterOf(value: string | null): string {
  return value !== null && /^\d{1,6}$/u.test(value) ? value : RATE_LIMIT_RETRY_AFTER;
}

/** The message orq gave for a bad request, at most 500 characters; the fixed message when it is unreadable. */
function rejectionMessageOf(text: string | null): string {
  const parsed = text === null ? undefined : parseJson(text);
  const error = isRecord(parsed) ? parsed["error"] : undefined;
  const message = isRecord(error) ? error["message"] : undefined;
  if (typeof message !== "string" || message === "" || REJECTION_REDACTED.test(message))
    return REJECTED;
  let prefix = "";
  let characters = 0;
  for (const character of message) {
    if (characters === REJECTION_MESSAGE_MAX) break;
    prefix += character;
    characters += 1;
  }
  return prefix;
}

/**
 * The idle and the overall timer of an answer: `touch` restarts the idle timer, the overall timer is never restarted.
 * Either one firing aborts the orq request.
 */
function streamTimers(abort: () => void): StreamTimers {
  const overall = setTimeout(abort, STREAM_MAX_MS);
  let idle = setTimeout(abort, STREAM_IDLE_MS);
  let stopped = false;
  return {
    touch() {
      // A chunk that arrives after the answer settled must not schedule a timer nobody clears.
      if (stopped) return;
      clearTimeout(idle);
      idle = setTimeout(abort, STREAM_IDLE_MS);
    },
    stop() {
      stopped = true;
      clearTimeout(overall);
      clearTimeout(idle);
    },
  };
}

/**
 * Passes the chunks of an orq body on unchanged. `onEnd` runs once when the body ends, when it fails and when the
 * client cancels the answer; a client cancel cancels the orq body too, and a failed body errors the answer.
 */
function relay(
  upstream: ReadableStream<Uint8Array>,
  timers: StreamTimers,
  onEnd: () => void,
): ReadableStream<Uint8Array> {
  const reader = upstream.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      let next: ReadableStreamReadResult<Uint8Array>;
      try {
        next = await reader.read();
      } catch (error) {
        onEnd();
        controller.error(error);
        return;
      }
      if (next.done) {
        onEnd();
        controller.close();
        return;
      }
      timers.touch();
      controller.enqueue(next.value);
    },
    cancel(reason) {
      onEnd();
      return reader.cancel(reason);
    },
  });
}

export function createAiGateway(options: AiGatewayOptions): AiGateway {
  const { runtime, orq, limiter, authLimiter, newReservationId, wait } = options;

  /** Authenticates the Bearer key: the Core's verdict on the SHA-256 of the whole key. */
  async function authenticate(key: string, projectId: string): Promise<AiKeyScope> {
    const keySha256 = await sha256Hex(key);
    const scope = await runtimeCall("authorize", () =>
      runtime.authorizeKey({ projectId, keySha256 }),
    );
    if (scope === null) throw invalidKey();
    return scope;
  }

  /**
   * Bounds one client address before asking the Core for a well-formed key, including keys with attacker-chosen project ids. The
   * verified project is limited separately after authorization.
   */
  async function authorize(request: Request): Promise<AiKeyScope> {
    // Cloudflare sets the header on every request; a request without it shares one bucket.
    const address = request.headers.get("cf-connecting-ip") ?? "unknown";
    const header = request.headers.get("authorization") ?? "";
    const key = /^Bearer /iu.test(header) ? header.slice("Bearer ".length) : "";
    const projectId = AI_KEY_PATTERN.exec(key)?.[1];
    // A key that is not well formed is refused before the shared address bucket or the Core is touched.
    if (projectId === undefined) throw invalidKey();
    await enforceLimit(authLimiter, address, "address_rate_limit");
    const scope = await authenticate(key, projectId);
    await enforceLimit(limiter, scope.projectId, "rate_limit");
    return scope;
  }

  async function enforceLimit(bound: Limiter, key: string, operation: string): Promise<void> {
    const decision = await runtimeCall(operation, () => bound.limit({ key }));
    if (!decision.success)
      throw new AiFailure("ai_rate_limited", RATE_LIMITED, {
        "retry-after": RATE_LIMIT_RETRY_AFTER,
      });
  }

  /** Runs one binding call; a failed call is logged by operation name and refused with 503. */
  async function runtimeCall<T>(operation: string, call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch {
      throw unavailable(operation);
    }
  }

  /** Forwards the checked body with the gateway's own key; `null` when no answer arrives (refused, timed out, lost). */
  async function callOrq(path: string, projectId: string, call: Call): Promise<OrqReply | null> {
    const controller = new AbortController();
    const headersTimer = setTimeout(() => controller.abort(), ORQ_TIMEOUT_MS);
    const headers: Record<string, string> = {
      authorization: `Bearer ${orq.apiKey}`,
      "x-orq-identity-id": projectId,
    };
    // A multipart form gets its content type from fetch, with its boundary.
    if (call.kind === "json") headers["content-type"] = "application/json";
    try {
      const response = await orq.fetch(`${orq.baseUrl}${path}`, {
        method: "POST",
        redirect: "manual",
        headers,
        body: call.kind === "json" ? call.body : call.form,
        signal: controller.signal,
      });
      if (!isSuccess(response.status)) {
        return {
          kind: "failed",
          status: response.status,
          retryAfter: response.headers.get("retry-after"),
          text: await response.text().catch(() => null),
        };
      }
      // The headers came: the answer has its own idle and overall timers from here on.
      return {
        kind: "answered",
        status: response.status,
        contentType: response.headers.get("content-type"),
        traceId: traceIdOf(response.headers.get("x-orq-trace-id")),
        body: response.body,
        timers: streamTimers(() => controller.abort()),
        abort: () => controller.abort(),
      };
    } catch {
      return null;
    } finally {
      // Still set while a failed answer is read, so a stalled error body is aborted too.
      clearTimeout(headersTimer);
    }
  }

  async function release(
    scope: AiKeyScope,
    reservationId: string,
    reason: AiReleaseInput["reason"],
  ): Promise<void> {
    try {
      await runtime.release({ scope, reservationId, reason });
    } catch {
      warnLine("ai_gateway_outcome", {
        outcome: "release_failed",
        projectId: scope.projectId,
        reservationId,
        reason,
      });
    }
  }

  async function refuse(
    scope: AiKeyScope,
    reservationId: string,
    reason: AiReleaseInput["reason"],
    response: Response,
  ): Promise<Response> {
    await release(scope, reservationId, reason);
    return response;
  }

  function upstreamFailure(): Response {
    return aiError("ai_upstream_unavailable", UPSTREAM_UNAVAILABLE);
  }

  /** Releases the hold of a call orq refused before any answer, and answers the customer with the matching status. */
  async function refusal(
    scope: AiKeyScope,
    reservationId: string,
    reply: OrqFailure,
  ): Promise<Response> {
    const { status } = reply;
    if (status === 429)
      return refuse(
        scope,
        reservationId,
        "rate_limited",
        aiError("ai_rate_limited", RATE_LIMITED, {
          "retry-after": retryAfterOf(reply.retryAfter),
        }),
      );
    if (ACCOUNT_STATUSES.has(status)) {
      warnLine("ai_gateway_outcome", {
        outcome: "orq_account_refused",
        projectId: scope.projectId,
        reservationId,
        status,
      });
      return refuse(scope, reservationId, "upstream_error", upstreamFailure());
    }
    if (REJECTED_STATUSES.has(status))
      return refuse(
        scope,
        reservationId,
        "invalid_request",
        aiResponse(
          status,
          JSON.stringify({
            error: {
              message: rejectionMessageOf(reply.text),
              type: "invalid_request_error",
              code: status === 404 ? "model_not_found" : "invalid_request",
            },
          }),
        ),
      );
    return refuse(scope, reservationId, "upstream_error", upstreamFailure());
  }

  /** Recorded cost, including zero, wins; only chat/Responses without usable cost use the marked USD 0.01 fallback. */
  async function settleCall(
    scope: AiKeyScope,
    reservationId: string,
    model: string,
    path: string,
    traceId: string | null,
  ): Promise<void> {
    const measured = traceId === null ? null : await fetchTraceCostNanoUsd(orq, traceId, wait);
    const fallback =
      measured === null && (path === "/v1/chat/completions" || path === "/v1/responses");
    if (measured === null) {
      warnLine("ai_gateway_outcome", {
        outcome: fallback ? "llm_cost_fallback" : "cost_unmeasured",
        projectId: scope.projectId,
        reservationId,
        model,
        traceId: traceId ?? "none",
        ...(fallback ? { fallbackNanoUsd: LLM_COST_FALLBACK_NANO_USD.toString() } : {}),
      });
    }
    await settleWithRetry({
      scope,
      reservationId,
      model,
      costNanoUsd: measured ?? (fallback ? LLM_COST_FALLBACK_NANO_USD : 0n),
      usage: fallback ? { fallback_nano_usd: Number(LLM_COST_FALLBACK_NANO_USD) } : {},
      traceId,
    });
  }

  async function trySettle(input: AiSettleInput): Promise<boolean> {
    try {
      await runtime.settle(input);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Settles at once, once more at once, then after 500 ms. A final failure is left to the sweep, and its line carries
   * the selected recorded or fallback cost and the trace for operator reconciliation.
   */
  async function settleWithRetry(input: AiSettleInput): Promise<void> {
    if (await trySettle(input)) return;
    if (await trySettle(input)) return;
    await new Promise<void>((resolve) => setTimeout(resolve, SETTLE_RETRY_MS));
    if (await trySettle(input)) return;
    warnLine("ai_gateway_outcome", {
      outcome: "settle_failed",
      projectId: input.scope.projectId,
      reservationId: input.reservationId,
      costNanoUsd: input.costNanoUsd.toString(),
      model: input.model,
      traceId: input.traceId ?? "none",
    });
  }

  /**
   * Answers with the orq answer streamed unchanged. The settlement is scheduled once: when the body ends, when the
   * client cancels it, or when the client leaves (its request signal aborts), and it aborts the orq request too.
   * `finish` releases the invocation once the settlement has run.
   */
  function answer(
    scope: AiKeyScope,
    reservationId: string,
    signal: AbortSignal,
    model: string,
    path: string,
    reply: OrqSuccess,
    finish: () => void,
  ): Response {
    let settled = false;
    const settle = (): void => {
      if (settled) return;
      settled = true;
      reply.timers.stop();
      void settleCall(scope, reservationId, model, path, reply.traceId).finally(finish);
    };
    if (signal.aborted) {
      reply.abort();
      settle();
      return new Response(null, { status: CLIENT_CLOSED_STATUS });
    }
    signal.addEventListener(
      "abort",
      () => {
        reply.abort();
        settle();
      },
      { once: true },
    );
    if (reply.body === null) {
      settle();
      return aiPassThrough(reply.status, null, reply.contentType);
    }
    return aiPassThrough(reply.status, relay(reply.body, reply.timers, settle), reply.contentType);
  }

  /** Refuses a model the scope's jurisdiction does not offer, before the Core is asked. */
  async function checkJurisdiction(scope: AiKeyScope, model: string): Promise<void> {
    if (scope.jurisdiction === "any") return;
    const locations = await fetchModelLocations(orq, model);
    if (!isEuOnlyLocations(locations))
      throw new AiFailure(
        "model_outside_jurisdiction",
        "The model is not available in this project's jurisdiction.",
      );
  }

  /** Asks the Core to hold the fixed amount of the call; a refusal is thrown as the customer's error. */
  async function admit(
    scope: AiKeyScope,
    reservationId: string,
    model: string,
    estimateNanoUsd: bigint,
  ): Promise<void> {
    const admission: AiAdmitResult = await runtimeCall("admit", () =>
      runtime.admit({
        scope,
        reservationId,
        model,
        estimateNanoUsd,
      }),
    );
    if (!admission.admitted) {
      const denial = DENIALS[admission.denial];
      throw new AiFailure(denial.code, denial.message, denial.headers);
    }
  }

  async function complete(
    request: Request,
    ctx: WaitUntilContext,
    path: string,
    kind: RouteKind,
  ): Promise<Response> {
    const scope = await authorize(request);
    const call = await readCall(request, kind, OUTPUT_TOKEN_PATHS.has(path));
    try {
      await checkJurisdiction(scope, call.model);
      prepareCall(call);
      const reservationId = newReservationId();
      await admit(
        scope,
        reservationId,
        call.model,
        call.kind === "json" && call.maxTokens !== null
          ? aiJsonHoldNanoUsd(call.maxTokens)
          : AI_HOLD_NANO_USD,
      );

      // Keep the invocation until the admitted hold resolves, even when the client leaves.
      const finish = keepAlive(ctx);
      let answered = false;
      try {
        const reply = await callOrq(path.slice(PUBLIC_PREFIX.length), scope.projectId, call);
        if (reply === null)
          return await refuse(scope, reservationId, "upstream_error", upstreamFailure());
        if (reply.kind === "answered") {
          answered = true;
          return answer(scope, reservationId, request.signal, call.model, path, reply, finish);
        }
        return await refusal(scope, reservationId, reply);
      } finally {
        if (!answered) finish();
      }
    } finally {
      releaseCall(call);
    }
  }

  /**
   * Opens orq's realtime route for the model with the gateway's key. Returns the upgraded socket, orq's failed answer,
   * or `null` when no answer arrives within the timeout.
   */
  async function openRealtime(
    model: string,
    projectId: string,
  ): Promise<OrqUpgrade | OrqFailure | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ORQ_TIMEOUT_MS);
    // orq records the session under the W3C trace id it is sent, and its upgrade answer carries no trace id.
    const traceId = randomHex(16);
    try {
      const response = await orq.fetch(
        `${orq.baseUrl}/realtime?model=${encodeURIComponent(model)}`,
        {
          method: "GET",
          redirect: "manual",
          headers: {
            upgrade: "websocket",
            authorization: `Bearer ${orq.apiKey}`,
            "x-orq-identity-id": projectId,
            traceparent: `00-${traceId}-${randomHex(8)}-01`,
          },
          signal: controller.signal,
        },
      );
      const socket = response.webSocket ?? null;
      if (socket === null)
        return {
          kind: "failed",
          status: response.status,
          retryAfter: response.headers.get("retry-after"),
          text: await response.text().catch(() => null),
        };
      return {
        kind: "upgraded",
        traceId,
        socket,
      };
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Answers the upgrade with the customer's socket, and passes the messages of the session both ways, unchanged. The
   * session ends when either side closes or fails, at the five minute limit, or after a minute with no message in
   * either direction; the end closes both sides once and settles the call once.
   */
  function session(
    scope: AiKeyScope,
    reservationId: string,
    model: string,
    upgrade: OrqUpgrade,
    finish: () => void,
  ): Response {
    const pair = new WebSocketPair();
    const customer = pair[0];
    const local = pair[1];
    const upstream = upgrade.socket;
    local.binaryType = "arraybuffer";
    upstream.binaryType = "arraybuffer";
    local.accept();
    upstream.accept();
    let ended = false;
    // The reason is always one of the fixed strings below: a peer's own reason is never passed on.
    const end = (code: number, reason: string): void => {
      if (ended) return;
      ended = true;
      clearTimeout(overall);
      clearTimeout(idle);
      void settleCall(scope, reservationId, model, REALTIME_PATH, upgrade.traceId).finally(finish);
      for (const socket of [local, upstream]) {
        if (socket.readyState !== WEBSOCKET_OPEN) continue;
        try {
          socket.close(code, reason);
        } catch {
          // Closing a peer can fail after a transport error; money and the other peer still resolve.
        }
      }
    };
    const overall = setTimeout(() => end(NORMAL_CLOSE_CODE, "session limit"), AI_REALTIME_MAX_MS);
    const idleEnd = (): void => end(IDLE_CLOSE_CODE, "session idle");
    let idle = setTimeout(idleEnd, AI_REALTIME_IDLE_MS);
    const touch = (): void => {
      clearTimeout(idle);
      idle = setTimeout(idleEnd, AI_REALTIME_IDLE_MS);
    };
    for (const [from, to] of [
      [local, upstream],
      [upstream, local],
    ] as const) {
      from.addEventListener("message", (event) => {
        if (ended) return;
        touch();
        try {
          to.send(event.data);
        } catch {
          end(SESSION_ERROR_CODE, "session error");
        }
      });
      from.addEventListener("close", (event) => end(sendableCode(event.code), "session closed"));
      from.addEventListener("error", () => end(SESSION_ERROR_CODE, "session error"));
    }
    return new Response(null, { status: 101, webSocket: customer });
  }

  /**
   * The realtime voice route: a WebSocket upgrade to orq's realtime route, checked and admitted like a POST call. It
   * is a server-side route, since a browser WebSocket cannot send the Bearer key. Hosted acceptance is still pending:
   * the latest orq probe closed with 1011 before messages, even after the voice models were enabled.
   */
  async function realtime(request: Request, ctx: WaitUntilContext): Promise<Response> {
    const scope = await authorize(request);
    const model = realtimeModelOf(request);
    await checkJurisdiction(scope, model);

    const reservationId = newReservationId();
    await admit(scope, reservationId, model, AI_HOLD_NANO_USD);

    // The invocation stays alive until the session is settled, or until no session is opened.
    const finish = keepAlive(ctx);
    let opened = false;
    try {
      const reply = await openRealtime(model, scope.projectId);
      if (reply === null)
        return await refuse(scope, reservationId, "upstream_error", upstreamFailure());
      if (reply.kind === "failed") return await refusal(scope, reservationId, reply);
      try {
        const response = session(scope, reservationId, model, reply, finish);
        opened = true;
        return response;
      } catch {
        try {
          reply.socket.close(SESSION_ERROR_CODE, "session error");
        } catch {
          // The setup failure may also have closed the upstream socket.
        }
        return await refuse(scope, reservationId, "upstream_error", upstreamFailure());
      }
    } finally {
      if (!opened) finish();
    }
  }

  /** Enabled models stay leased through EU metadata lookup and final response serialization. */
  async function listModels(request: Request): Promise<Response> {
    const scope = await authorize(request);
    let loaded = false;
    try {
      return await withOrqJson(
        orq,
        `${orq.baseUrl}/models`,
        ENABLED_MODELS_BYTES,
        async (parsed) => {
          const models = isRecord(parsed) ? parsed["data"] : undefined;
          if (!Array.isArray(models)) return upstreamFailure();
          loaded = true;
          const euIds = scope.jurisdiction === "eu" ? await fetchEuModelIds(orq) : null;
          const data = models.filter((entry) => {
            const id = isRecord(entry) ? entry["id"] : undefined;
            return typeof id === "string" && id.length > 0 && (euIds === null || euIds.has(id));
          });
          return aiResponse(200, JSON.stringify({ object: "list", data }));
        },
      );
    } catch (error) {
      if (loaded || error instanceof MemoryCapacityError) throw error;
      return upstreamFailure();
    }
  }

  async function dispatch(request: Request, ctx: WaitUntilContext): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === REALTIME_PATH) return realtime(request, ctx);
    if (url.search !== "") throw new AiFailure("not_found", "The route does not exist.");
    if (request.method === "GET" && url.pathname === MODELS_PATH) return listModels(request);
    const kind = request.method === "POST" ? POST_ROUTES.get(url.pathname) : undefined;
    if (kind === undefined) throw new AiFailure("not_found", "The route does not exist.");
    return complete(request, ctx, url.pathname, kind);
  }

  async function sweep(): Promise<void> {
    try {
      const { released } = await runtime.sweep({
        olderThanMs: SWEEP_OLDER_THAN_MS,
        limit: SWEEP_LIMIT,
      });
      if (released > 0) console.log(JSON.stringify({ event: "ai_gateway_sweep", released }));
    } catch (error) {
      warnLine("ai_gateway_sweep", { outcome: "sweep_failed" });
      throw error;
    }
  }

  return {
    async fetch(request, ctx) {
      try {
        return await dispatch(request, ctx);
      } catch (error) {
        if (error instanceof AiFailure) return aiError(error.code, error.message, error.headers);
        warnLine("ai_gateway_outcome", { outcome: "unexpected_error" });
        return aiError("ai_unavailable", AI_UNAVAILABLE);
      }
    },
    scheduled: sweep,
  };
}
