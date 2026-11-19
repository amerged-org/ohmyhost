import {
  AI_JSON_BODY_LIMIT,
  AI_MAX_OUTPUT_TOKENS,
  AI_MULTIPART_BODY_LIMIT,
} from "@ohmyhost/platform";
import { AiFailure } from "./responses.js";

/** The body a POST route reads: a JSON object, or multipart form data. */
export type BodyKind = "json" | "multipart";
/** What a POST route takes: JSON only, or JSON or multipart form data (uploads), chosen by the content type. */
export type RouteKind = "json" | "either";

/*
 * The POST routes by the path the customer calls. Each is forwarded to the same path under the orq router, with the
 * `/v1` prefix removed. Upload routes take JSON or multipart form data; every other route takes JSON.
 */
export const POST_ROUTES: ReadonlyMap<string, RouteKind> = new Map<string, RouteKind>([
  ["/v1/chat/completions", "json"],
  ["/v1/responses", "json"],
  ["/v1/images/generations", "json"],
  ["/v1/images/edits", "either"],
  ["/v1/audio/transcriptions", "either"],
  ["/v1/audio/speech", "json"],
  ["/v1/ocr", "json"],
  ["/v1/decisions", "json"],
]);

/** The POST routes whose calls generate output tokens: only these are read for an output-token limit and held by it. */
export const OUTPUT_TOKEN_PATHS: ReadonlySet<string> = new Set([
  "/v1/chat/completions",
  "/v1/responses",
]);

export const MODELS_PATH = "/v1/models";
export const REALTIME_PATH = "/v1/realtime";

const MODEL_MAX_LENGTH = 200;
const MULTIPART = "multipart/form-data";
/**
 * The top-level keys of orq's control surface, which a JSON body and a multipart form may not carry in any jurisdiction:
 * they route the call to other models, add fallbacks, retries or timeouts, cache answers across requests, or replace the
 * identity the gateway sets. Exact names only, so an OpenAI field such as `prompt_cache_key` passes.
 */
export const ORQ_CONTROL_KEYS: ReadonlySet<string> = new Set([
  "orq",
  "load_balancer",
  "fallbacks",
  "fallback_on_codes",
  "retry",
  "cache",
  "timeout",
  "plugins",
  "models",
  "route",
  "routing",
]);
/** The refusal of an orq control field, the same in every jurisdiction. */
export const ORQ_CONTROL_REFUSED =
  "The request carries an orq routing or override field, which is not available here.";
/** The most JSON structural and value tokens; primitive arrays are bounded too, before JSON.parse allocates a tree. */
export const JSON_STRUCTURE_MAX = 100_000;
/** The largest number of multipart form parts, checked before FormData can allocate one object per part. */
export const MULTIPART_PARTS_MAX = 1_000;
/** The longest a request body may take to arrive, from its first byte to its last. */
export const BODY_READ_MS = 30_000;
/** The longest a request body may pause without a byte, so a stalled upload frees its memory well before BODY_READ_MS. */
export const BODY_IDLE_MS = 10_000;
/**
 * A conservative memory budget for received bodies through upstream response headers. JSON bytes count six times
 * (UTF-8 bytes, UTF-16 strings, parsed tree and fetch copy), multipart bytes four times (bytes, FormData and upload).
 * Declared lengths do not consume the budget: a slow reader cannot reserve capacity it has not received.
 */
export const IN_FLIGHT_BYTES_MAX = 104 * 1024 * 1024;
const JSON_MEMORY_WEIGHT = 6;
const MULTIPART_MEMORY_WEIGHT = 4;

let inFlightBytes = 0;

export interface MemoryLease {
  readonly heldBytes: number;
  resize(bytes: number): void;
  release(): void;
}

/** Pressure uses the same 503 for customer bodies and provider metadata; no capacity is queued. */
export class MemoryCapacityError extends AiFailure {
  public constructor() {
    super("ai_unavailable", "The AI gateway is busy with other requests. Retry later.");
  }
}

/** One isolate-wide memory pool for request bodies, provider JSON and the derived values they retain. */
export function holdMemory(bytes: number): MemoryLease {
  let heldBytes = 0;
  const lease: MemoryLease = {
    get heldBytes() {
      return heldBytes;
    },
    resize(next) {
      const growth = next - heldBytes;
      if (inFlightBytes + growth > IN_FLIGHT_BYTES_MAX) throw new MemoryCapacityError();
      inFlightBytes += growth;
      heldBytes = next;
    },
    release() {
      inFlightBytes -= heldBytes;
      heldBytes = 0;
    },
  };
  lease.resize(bytes);
  return lease;
}

interface BodyLease {
  readonly memory: MemoryLease;
  /** Scratch bytes freed after parsing, reserved again for the provider upload before admission. */
  readonly forwardBytes: number;
}

export interface JsonCall extends BodyLease {
  /**
   * The output-token limit a token-generating call requests, or the cap when it sends none: the basis of its credit hold.
   * Null for a call without an output-token notion, which keeps the fixed hold.
   */
  readonly maxTokens: number | null;
  readonly kind: "json";
  readonly model: string;
  /** The original JSON text; duplicate top-level keys are refused before forwarding. */
  readonly body: string;
}

export interface MultipartCall extends BodyLease {
  readonly kind: "multipart";
  readonly model: string;
  /** A new form built from the parsed entries, so the boundary is regenerated. */
  readonly form: FormData;
}

/** A request body that passed its checks: the model it names and the bytes the gateway forwards. */
export type Call = JsonCall | MultipartCall;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The parsed JSON value, or `undefined` when the text is not JSON. */
export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function invalid(message: string): AiFailure {
  return new AiFailure("invalid_request", message);
}

function tooLarge(): AiFailure {
  return new AiFailure("request_too_large", "The request body is too large for this route.");
}

/** Raised by the read deadline; it is told apart from a failed read by its class. */
class ReadDeadline extends Error {}

/**
 * Reads the body up to the limit, within the read deadline and the idle limit. The limit is enforced on every chunk,
 * not only on the declared length, and a body that stops arriving is refused when either deadline passes.
 */
async function readBounded(
  request: Request,
  limit: number,
  weight: number,
): Promise<{ bytes: Bytes; memory: MemoryLease }> {
  const memory = holdMemory(0);
  if (request.body === null) return { bytes: new Uint8Array(0) as Bytes, memory };
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let complete = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new ReadDeadline()), BODY_READ_MS);
  });
  try {
    for (;;) {
      const idle = new Promise<never>((_resolve, reject) => {
        idleTimer = setTimeout(() => reject(new ReadDeadline()), BODY_IDLE_MS);
      });
      const next = await Promise.race([reader.read(), deadline, idle]);
      clearTimeout(idleTimer);
      if (next.done) break;
      size += next.value.byteLength;
      if (size > limit) throw tooLarge();
      const cost = next.value.byteLength * weight;
      memory.resize(memory.heldBytes + cost);
      chunks.push(next.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    complete = true;
    return { bytes, memory };
  } catch (error) {
    if (error instanceof AiFailure) throw error;
    if (error instanceof ReadDeadline) throw invalid("The request body was not received in time.");
    throw invalid("The request body could not be read.");
  } finally {
    clearTimeout(timer);
    clearTimeout(idleTimer);
    if (!complete) memory.release();
    await reader.cancel().catch(() => undefined);
  }
}

/** Count tokens without allocating a JSON tree, excluding punctuation inside string values. */
function countStructure(bytes: Bytes): number {
  let count = 0;
  let quoted = false;
  let escaped = false;
  for (const byte of bytes) {
    if (quoted) {
      if (escaped) escaped = false;
      else if (byte === 0x5c) escaped = true;
      else if (byte === 0x22) quoted = false;
    } else if (byte === 0x22) {
      quoted = true;
      count += 1;
    } else if (
      byte === 0x5b ||
      byte === 0x5d ||
      byte === 0x7b ||
      byte === 0x7d ||
      byte === 0x2c ||
      byte === 0x3a
    )
      count += 1;
    if (count > JSON_STRUCTURE_MAX) return count;
  }
  return count;
}

function controlRefused(): AiFailure {
  return invalid(ORQ_CONTROL_REFUSED);
}

/** The bytes of a request body. */
type Bytes = Uint8Array<ArrayBuffer>;

/** The media type of a Content-Type header: the part before the parameters, lower case. */
function mediaTypeOf(value: string): string {
  return (value.split(";")[0] ?? "").trim().toLowerCase();
}

/** The model id: a non-empty string of at most 200 characters. */
function modelOf(value: unknown): string {
  if (typeof value !== "string" || value === "" || value.length > MODEL_MAX_LENGTH)
    throw invalid("The request needs a model of 1 to 200 characters.");
  return value;
}

/**
 * The model of a realtime upgrade: the request must be a WebSocket upgrade, and its query must hold exactly one
 * parameter, `model`, once. Nothing else is read, so the upgrade has no body.
 */
export function realtimeModelOf(request: Request): string {
  if (request.headers.get("upgrade")?.toLowerCase() !== "websocket")
    throw invalid("The realtime route needs a WebSocket upgrade.");
  const url = new URL(request.url);
  const names = [...url.searchParams.keys()];
  if (names.length !== 1 || names[0] !== "model")
    throw invalid("The realtime route takes exactly one query parameter, model.");
  return modelOf(url.searchParams.get("model"));
}

/**
 * The body a route reads, by its media type: JSON, or multipart form data on an upload route. Any other content type
 * is refused before the body is read.
 */
function bodyKindOf(route: RouteKind, mediaType: string): BodyKind {
  if (mediaType === "application/json") return "json";
  if (route === "either" && mediaType === MULTIPART) return "multipart";
  throw invalid(
    route === "either"
      ? "The request body must be application/json or multipart/form-data."
      : "The request body must be application/json.",
  );
}

/** Duplicate top-level keys could make orq and the gateway select different models. Nested keys stay untouched. */
function uniqueTopLevelKeys(text: string): void {
  const keys = new Set<string>();
  let depth = 0;
  let keyExpected = false;
  for (let position = 0; position < text.length; position += 1) {
    const character = text.charCodeAt(position);
    if (character === 0x22) {
      const start = position;
      for (position += 1; position < text.length; position += 1) {
        const next = text.charCodeAt(position);
        if (next === 0x5c) position += 1;
        else if (next === 0x22) break;
      }
      if (depth === 1 && keyExpected) {
        const key = JSON.parse(text.slice(start, position + 1)) as string;
        if (keys.has(key)) throw invalid("The request body has duplicate top-level keys.");
        keys.add(key);
        keyExpected = false;
      }
    } else if (character === 0x7b || character === 0x5b) {
      depth += 1;
      if (depth === 1) keyExpected = true;
    } else if (character === 0x7d || character === 0x5d) depth -= 1;
    else if (depth === 1 && character === 0x2c) keyExpected = true;
  }
}

/** Refuses JSON allocation amplification before any JSON.parse, for customer and upstream bodies alike. */
export function checkJsonStructure(bytes: Bytes): void {
  if (countStructure(bytes) > JSON_STRUCTURE_MAX)
    throw invalid("The request body has too many JSON values or containers.");
}

const OUTPUT_LIMIT_FIELDS = ["max_tokens", "max_output_tokens", "max_completion_tokens"] as const;

/** The largest output-token limit the call names, checked against the cap; the cap when it names none. */
function maxTokensOf(parsed: Record<string, unknown>): number {
  let requested: number | null = null;
  for (const field of OUTPUT_LIMIT_FIELDS) {
    const value = parsed[field];
    if (value === undefined || value === null) continue;
    if (
      typeof value !== "number" ||
      !Number.isSafeInteger(value) ||
      value < 1 ||
      value > AI_MAX_OUTPUT_TOKENS
    )
      throw invalid(`${field} must be a whole number from 1 to ${String(AI_MAX_OUTPUT_TOKENS)}.`);
    requested = Math.max(requested ?? 0, value);
  }
  return requested ?? AI_MAX_OUTPUT_TOKENS;
}

function jsonCall(bytes: Bytes, outputTokens: boolean): Omit<JsonCall, keyof BodyLease> {
  checkJsonStructure(bytes);
  const text = new TextDecoder().decode(bytes);
  const parsed = parseJson(text);
  if (!isRecord(parsed)) throw invalid("The request body must be a JSON object.");
  if (Object.keys(parsed).some((key) => ORQ_CONTROL_KEYS.has(key))) throw controlRefused();
  uniqueTopLevelKeys(text);
  return {
    kind: "json",
    model: modelOf(parsed["model"]),
    maxTokens: outputTokens ? maxTokensOf(parsed) : null,
    body: text,
  };
}

/** Bound part allocation before Response.formData() parses customer-controlled multipart data. */
function checkMultipartParts(bytes: Bytes, contentType: string): void {
  const boundariesInHeader = [
    ...contentType.matchAll(/(?:^|;)\s*boundary=(?:"([^"]*)"|([^;]*))/giu),
  ];
  if (boundariesInHeader.length !== 1)
    throw invalid("The request body is not valid multipart form data.");
  const boundaryMatch = boundariesInHeader[0];
  const boundary = boundaryMatch?.[1] ?? boundaryMatch?.[2]?.trim() ?? "";
  if (boundary === "" || boundary.length > 70 || /[\\\r\n]/u.test(boundary))
    throw invalid("The request body is not valid multipart form data.");
  const delimiter = new TextEncoder().encode(`--${boundary}`);
  let boundaries = 0;
  for (let start = 0; start < bytes.length; ) {
    let matches = true;
    for (let index = 0; index < delimiter.length; index += 1) {
      if (bytes[start + index] !== delimiter[index]) {
        matches = false;
        break;
      }
    }
    if (
      matches &&
      !(bytes[start + delimiter.length] === 0x2d && bytes[start + delimiter.length + 1] === 0x2d) &&
      ++boundaries > MULTIPART_PARTS_MAX
    )
      throw invalid("The form has too many parts.");
    const newline = bytes.indexOf(0x0a, start);
    if (newline < 0) break;
    start = newline + 1;
  }
}

async function multipartCall(
  bytes: Bytes,
  contentType: string,
): Promise<Omit<MultipartCall, keyof BodyLease>> {
  checkMultipartParts(bytes, contentType);
  let parsed: FormData;
  try {
    parsed = await new Response(bytes, { headers: { "content-type": contentType } }).formData();
  } catch {
    throw invalid("The request body is not valid multipart form data.");
  }
  const models = parsed.getAll("model");
  if (models.length !== 1) throw invalid('The form needs exactly one "model" field.');
  const form = new FormData();
  for (const [name, value] of parsed) {
    if (ORQ_CONTROL_KEYS.has(name)) throw controlRefused();
    form.append(name, value);
  }
  return { kind: "multipart", model: modelOf(models[0]), form };
}

/**
 * Reads the body of one POST route and checks the fields the gateway reads, or refuses it with 400 or 413. The body
 * bytes are counted as they arrive against the isolate's weighted memory budget through upstream headers. A reader
 * that exceeds it is refused with 503; no capacity is reserved for bytes that have not arrived.
 */
export async function readCall(
  request: Request,
  route: RouteKind,
  outputTokens: boolean,
): Promise<Call> {
  const contentType = request.headers.get("content-type") ?? "";
  const kind = bodyKindOf(route, mediaTypeOf(contentType));
  const limit = kind === "json" ? AI_JSON_BODY_LIMIT : AI_MULTIPART_BODY_LIMIT;
  const declared = request.headers.get("content-length");
  if (declared !== null && Number(declared) > limit) throw tooLarge();
  const { bytes, memory } = await readBounded(
    request,
    limit,
    kind === "json" ? JSON_MEMORY_WEIGHT : MULTIPART_MEMORY_WEIGHT,
  );
  try {
    const call =
      kind === "json" ? jsonCall(bytes, outputTokens) : await multipartCall(bytes, contentType);
    // The joined read buffer is no longer retained by the parsed request; its forwarding copy is needed later.
    memory.resize(memory.heldBytes - bytes.byteLength);
    return { ...call, memory, forwardBytes: bytes.byteLength };
  } catch (error) {
    memory.release();
    throw error;
  }
}

/** Releases the checked request's weighted memory reservation, exactly once after forwarding or refusal. */
export function releaseCall(call: Call): void {
  call.memory.release();
}

/** Reserve the provider upload copy after jurisdiction lookup and before the credit hold is admitted. */
export function prepareCall(call: Call): void {
  call.memory.resize(call.memory.heldBytes + call.forwardBytes);
}
