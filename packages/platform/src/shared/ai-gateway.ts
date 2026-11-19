/**
 * The contract between the AI gateway Worker (`apps/ai-gateway`) and the Core (`AiGatewayRuntime` in
 * `apps/control-store`). Types, names and the call limits only: recorded orq cost has priority, including zero;
 * only answered chat/Responses calls without usable cost use the marked USD 0.01 fallback. Credit arithmetic lives
 * in the Core. See docs/plan/specs/2026-11-02-ai-gateway.md.
 */

/** The fixed credit hold of one call that has no output-token limit (multipart, realtime): USD 0.50, in nano-USD (1e-9 USD). */
export const AI_HOLD_NANO_USD = 500_000_000n;
/** The most output tokens a JSON call may request (`max_tokens`, `max_output_tokens`, `max_completion_tokens`). A call without a limit is held as if it asked for this many. */
export const AI_MAX_OUTPUT_TOKENS = 16_384;
/** The worst-case orq cost of one requested output token that sizes a JSON call's hold: USD 0.0001, in nano-USD. */
export const AI_TOKEN_HOLD_NANO_USD = 100_000n;
/** The credit hold of a JSON call that requests `maxTokens` output tokens: its per-token worst case, never below the fixed hold. */
export function aiJsonHoldNanoUsd(maxTokens: number): bigint {
  const hold = AI_TOKEN_HOLD_NANO_USD * BigInt(maxTokens);
  return hold > AI_HOLD_NANO_USD ? hold : AI_HOLD_NANO_USD;
}
/**
 * The unresolved AI calls one organization may hold at once: the markers of admitted calls whose credit reservation is
 * still open. A call over the cap is refused before anything is reserved, so a burst cannot exhaust the credit.
 */
export const AI_MAX_OPEN_CALLS = 8;
/** The largest JSON request body the gateway forwards, in bytes. */
export const AI_JSON_BODY_LIMIT = 16 * 1024 * 1024;
/** The largest multipart request body (audio and image uploads, with their form fields) the gateway forwards, in bytes. */
export const AI_MULTIPART_BODY_LIMIT = 26 * 1024 * 1024;
/** The longest a realtime voice session lasts: the gateway closes both sides when it reaches this age. */
export const AI_REALTIME_MAX_MS = 300_000;
/** A realtime voice session without a message in either direction for this long ends. */
export const AI_REALTIME_IDLE_MS = 60_000;
/** The meter the AI gateway bills. Its rate card prices one USD micro of orq cost in credit micros (unit `usd_micro`). */
export const AI_METER = "ai.cost";
export const AI_METER_UNIT = "usd_micro";

/** Secret and plain-text names the platform injects into a customer Worker when `ai.enabled` is declared. */
export const AI_KEY_NAME = "OHMYHOST_AI_KEY";
export const AI_BASE_URL_NAME = "OHMYHOST_AI_BASE_URL";

/**
 * A project's gateway key is `omh_ai_<projectId>_<43 base64url characters>`. The gateway reads the project id from
 * the key only to find the row; the Core compares the SHA-256 of the whole key string with the stored digest.
 */
export const AI_KEY_PATTERN = /^omh_ai_([0-7][0-9A-HJKMNP-TV-Z]{25})_[A-Za-z0-9_-]{43}$/u;

/** The public gateway origins. The hostnames are owned by the platform; the base URL is the origin plus `/v1`. */
export const AI_GATEWAY_ORIGIN_PRODUCTION = "https://ai.ohmyho.st";
export const AI_GATEWAY_ORIGIN_DEVELOPMENT = "https://ai.dev.ohmyho.st";

export function aiBaseUrl(origin: string): string {
  return `${origin}/v1`;
}

export function createAiKey(projectId: string, secret: string): string {
  const key = `omh_ai_${projectId}_${secret}`;
  if (!AI_KEY_PATTERN.test(key)) throw new TypeError("Invalid AI gateway key");
  return key;
}

export type AiJurisdiction = "eu" | "any";

/** What a verified gateway key stands for. `jurisdiction` is the project's declared choice for this environment. */
export interface AiKeyScope {
  readonly organizationId: string;
  readonly projectId: string;
  readonly environmentId: string;
  readonly jurisdiction: AiJurisdiction;
}

/** Why the Core refuses a call before any orq request. Each is also the `code` of the error body. */
export type AiDenial =
  | "paid_plan_required"
  | "insufficient_organization_credits"
  | "project_budget_exceeded"
  | "too_many_open_calls";

export type AiAdmitResult =
  | { readonly admitted: true; readonly reservedMicros: number }
  | { readonly admitted: false; readonly denial: AiDenial }
  | { readonly admitted: false; readonly denial: "unavailable" };

export interface AiAdmitInput {
  readonly scope: AiKeyScope;
  /** A fresh ULID per call; it is the credit reservation id. */
  readonly reservationId: string;
  readonly model: string;
  /** Fixed admission hold in nano-USD; the final measured cost may exceed it. The Core uses the active rate card. */
  readonly estimateNanoUsd: bigint;
}

export interface AiSettleInput {
  readonly scope: AiKeyScope;
  readonly reservationId: string;
  readonly model: string;
  /** Recorded orq cost in nano-USD, a marked USD 0.01 unmeasured chat/Responses fallback, or zero for other unmeasured routes. */
  readonly costNanoUsd: bigint;
  /** Only an assumed chat/Responses cost sets `fallback_nano_usd`; measured calls and other routes use an empty object. */
  readonly usage: Readonly<Record<string, number>>;
  /** The orq trace id (`x-orq-trace-id`) for reconciliation, when the response carried one. */
  readonly traceId: string | null;
}

export type AiSettleResult =
  | { readonly settled: true; readonly chargedMicros: number }
  | { readonly settled: false; readonly reason: "unknown_reservation" | "already_resolved" };

export interface AiReleaseInput {
  readonly scope: AiKeyScope;
  readonly reservationId: string;
  readonly reason: "upstream_error" | "rate_limited" | "client_aborted" | "invalid_request";
}

/** The private Core capability the gateway Worker binds. It carries no plaintext key and no prompt or answer text. */
export interface AiGatewayRuntime {
  /** `null` for an unknown, retired or ambiguous key. */
  authorizeKey(input: {
    readonly projectId: string;
    readonly keySha256: string;
  }): Promise<AiKeyScope | null>;
  admit(input: AiAdmitInput): Promise<AiAdmitResult>;
  settle(input: AiSettleInput): Promise<AiSettleResult>;
  release(input: AiReleaseInput): Promise<{ readonly released: boolean }>;
  /** Releases AI reservations older than `olderThanMs` that no call settled (a crashed Worker); at most `limit` per run. */
  sweep(input: {
    readonly olderThanMs: number;
    readonly limit: number;
  }): Promise<{ readonly released: number }>;
}
