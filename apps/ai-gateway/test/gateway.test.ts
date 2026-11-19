import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AI_HOLD_NANO_USD,
  AI_MAX_OUTPUT_TOKENS,
  AI_TOKEN_HOLD_NANO_USD,
  AI_JSON_BODY_LIMIT,
  AI_MULTIPART_BODY_LIMIT,
  type AiAdmitResult,
  type AiJurisdiction,
} from "@ohmyhost/platform";
import {
  createAiGateway,
  ORQ_TIMEOUT_MS,
  STREAM_IDLE_MS,
  SWEEP_OLDER_THAN_MS,
} from "../src/gateway.js";
import {
  BODY_IDLE_MS,
  BODY_READ_MS,
  JSON_STRUCTURE_MAX,
  MULTIPART_PARTS_MAX,
} from "../src/request.js";
import {
  answer,
  bodyOf,
  FakeCore,
  FakeLimiter,
  FakeOrq,
  fakeContext,
  headersOf,
  HAIKU,
  KEY,
  ORQ_BASE_URL,
  ORQ_KEY,
  scopeOf,
  sseBody,
  telemetryReply,
  TELEMETRY_URL,
} from "./fakes.js";

const CATALOG_URL = "https://my.orq.ai/v2/model-catalog";

const JSON_PATHS = [
  "/v1/chat/completions",
  "/v1/responses",
  "/v1/images/generations",
  "/v1/audio/speech",
  "/v1/ocr",
  "/v1/decisions",
];
/** Routes that take JSON or multipart form data, chosen by the request's content type. */
const EITHER_PATHS = ["/v1/images/edits", "/v1/audio/transcriptions"];
/** The routes orq.ai serves that the gateway does not offer: each answers 404 not_found. */
const REMOVED_PATHS = [
  "/v1/completions",
  "/v1/embeddings",
  "/v1/images/variations",
  "/v1/moderations",
  "/v1/audio/translations",
  "/v1/rerank",
];

/** The top-level keys of orq's control surface: routing, fallbacks, retries, caching, timeouts and identity override. */
const ORQ_CONTROL_KEYS = [
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
];
const ORQ_CONTROL_REFUSED =
  "The request carries an orq routing or override field, which is not available here.";

interface Harness {
  core: FakeCore;
  limiter: FakeLimiter;
  authLimiter: FakeLimiter;
  orq: FakeOrq;
  ctx: ReturnType<typeof fakeContext>;
  waits: number[];
  send(request: Request): Promise<Response>;
}

function harness(jurisdiction: AiJurisdiction = "any"): Harness {
  const core = new FakeCore();
  core.scope = scopeOf(jurisdiction);
  const limiter = new FakeLimiter();
  const authLimiter = new FakeLimiter();
  const orq = new FakeOrq();
  const waits: number[] = [];
  let reservations = 0;
  const gateway = createAiGateway({
    runtime: core,
    orq: { fetch: orq.fetch, apiKey: ORQ_KEY, baseUrl: ORQ_BASE_URL },
    limiter,
    authLimiter,
    newReservationId: () => {
      reservations += 1;
      return `RES${reservations}`;
    },
    wait: async (ms) => {
      waits.push(ms);
    },
  });
  const ctx = fakeContext();
  return {
    core,
    limiter,
    authLimiter,
    orq,
    ctx,
    waits,
    send: (request) => gateway.fetch(request, ctx),
  };
}

function post(path: string, body: unknown, headers: Record<string, string> = {}): Request {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return new Request(`https://ai.test${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json", ...headers },
    body: text,
  });
}

function formOf(fields: [string, string | Blob, string?][]): FormData {
  const form = new FormData();
  for (const [name, value, fileName] of fields) {
    if (typeof value === "string") form.append(name, value);
    else form.append(name, value, fileName);
  }
  return form;
}

function multipart(path: string, form: FormData): Request {
  return new Request(`https://ai.test${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${KEY}` },
    body: form,
  });
}

/** A body whose size is not declared up front, so the limit is enforced while it is read. */
function streamedRequest(path: string, size: number, contentType: string): Request {
  const chunk = new Uint8Array(1024 * 1024);
  let sent = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= size) {
        controller.close();
        return;
      }
      sent += chunk.byteLength;
      controller.enqueue(chunk);
    },
  });
  return new Request(`https://ai.test${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${KEY}`, "content-type": contentType },
    body: stream,
    duplex: "half",
  } as RequestInit);
}

/** The gateway's warning lines, parsed. */
function linesOf(warn: { mock: { calls: unknown[][] } }): Record<string, unknown>[] {
  return warn.mock.calls.map(([line]) => JSON.parse(String(line)) as Record<string, unknown>);
}

/** Reads the answer to its end, lets the pass-through settle, then waits for every settlement the gateway scheduled. */
async function settled(ctx: Harness["ctx"], response?: Response): Promise<void> {
  // An answer is settled when its body ends or is cancelled, so the body is read to its end first.
  await response?.text().catch(() => undefined);
  await new Promise((resolve) => setTimeout(resolve, 0));
  await ctx.drain();
}

let warn: ReturnType<typeof vi.spyOn>;
let log: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  log = vi.spyOn(console, "log").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("routes", () => {
  it.each(JSON_PATHS)("forwards %s as JSON to the same path under the orq router", async (path) => {
    const h = harness();
    h.orq.respond(() => answer(JSON.stringify({ ok: true }), null));
    const response = await h.send(post(path, { model: HAIKU, extra: [1, 2] }));
    expect(response.status).toBe(200);
    expect(h.orq.calls).toHaveLength(1);
    expect(h.orq.calls[0]?.url).toBe(`${ORQ_BASE_URL}${path.slice("/v1".length)}`);
    expect(h.orq.calls[0]?.init.method).toBe("POST");
    expect(h.orq.calls[0]?.init.redirect).toBe("manual");
    expect(h.orq.calls[0]?.init.body).toEqual(expect.any(String));
    await settled(h.ctx, response);
  });

  it.each(EITHER_PATHS)(
    "forwards %s as JSON when the content type is application/json",
    async (path) => {
      const h = harness();
      h.orq.respond(() => answer(JSON.stringify({ ok: true }), null));
      const response = await h.send(post(path, { model: HAIKU, extra: [1, 2] }));
      expect(response.status).toBe(200);
      expect(h.orq.calls[0]?.url).toBe(`${ORQ_BASE_URL}${path.slice("/v1".length)}`);
      expect(bodyOf(h.orq.calls[0]?.init)).toEqual({ model: HAIKU, extra: [1, 2] });
      expect(headersOf(h.orq.calls[0]?.init)["content-type"]).toBe("application/json");
      await settled(h.ctx, response);
    },
  );

  it.each(EITHER_PATHS)(
    "forwards %s as multipart when the content type is multipart/form-data",
    async (path) => {
      const h = harness();
      h.orq.respond(() => answer(JSON.stringify({ ok: true }), null));
      const form = formOf([
        ["model", HAIKU],
        ["file", new Blob(["audio"]), "clip.wav"],
      ]);
      const response = await h.send(multipart(path, form));
      expect(response.status).toBe(200);
      expect(h.orq.calls[0]?.url).toBe(`${ORQ_BASE_URL}${path.slice("/v1".length)}`);
      expect(h.orq.calls[0]?.init.body).toBeInstanceOf(FormData);
      await settled(h.ctx, response);
    },
  );

  it.each(REMOVED_PATHS)(
    "answers an unoffered route %s with 404 not_found without calling orq or the Core",
    async (path) => {
      const h = harness();
      const response = await h.send(post(path, { model: HAIKU, input: "x" }));
      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({ error: { code: "not_found" } });
      expect(h.orq.calls).toEqual([]);
      expect(h.core.authorizeCalls).toEqual([]);
    },
  );

  it.each([
    ["GET", "/v1/chat/completions"],
    ["PUT", "/v1/chat/completions"],
    ["POST", "/v1/models"],
    ["POST", "/v1/chat"],
    ["POST", "/v1/chat/completions/"],
    ["POST", "/v1/chat/completions?stream=1"],
    ["GET", "/v1/models?limit=1"],
    ["GET", "/v1/models/"],
    ["POST", "/v1/batches"],
    ["POST", "/v1/files"],
    ["POST", "/v1/realtime"],
    ["POST", "/v1/responses/resp_1"],
    ["POST", "/v1/chat/completions/.."],
    ["POST", "/v1/%2e%2e/models"],
    ["GET", "/v2/models"],
  ])("answers %s %s with 404 not_found without calling orq or the Core", async (method, path) => {
    const h = harness();
    const request = new Request(`https://ai.test${path}`, {
      method,
      headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
      body: method === "POST" ? JSON.stringify({ model: HAIKU }) : null,
    });
    const response = await h.send(request);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: {
        message: "The route does not exist.",
        type: "invalid_request_error",
        code: "not_found",
      },
    });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(h.orq.calls).toEqual([]);
    expect(h.core.authorizeCalls).toEqual([]);
  });

  it("resolves dot segments the URL parser removes, then routes the normalized path", async () => {
    const h = harness();
    h.orq.respond(() => answer(JSON.stringify({ ok: true }), null));
    const response = await h.send(
      new Request("https://ai.test/v1/./chat/../chat/completions", {
        method: "POST",
        headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
        body: JSON.stringify({ model: HAIKU }),
      }),
    );
    expect(response.status).toBe(200);
    expect(h.orq.calls[0]?.url).toBe(`${ORQ_BASE_URL}/chat/completions`);
    await settled(h.ctx, response);
  });
});

describe("authentication and limits", () => {
  it("answers 401 invalid_api_key for a missing or malformed key, before the Core is asked", async () => {
    const h = harness();
    const response = await h.send(
      new Request("https://ai.test/v1/chat/completions", {
        method: "POST",
        headers: { authorization: "Bearer nope", "content-type": "application/json" },
        body: JSON.stringify({ model: HAIKU }),
      }),
    );
    expect(response.status).toBe(401);
    expect((await response.json()) as object).toMatchObject({ error: { code: "invalid_api_key" } });
    expect(h.core.authorizeCalls).toEqual([]);
    expect(h.orq.calls).toEqual([]);
  });

  it("answers 401 when the Core does not know the key", async () => {
    const h = harness();
    h.core.scope = null;
    const response = await h.send(post("/v1/chat/completions", { model: HAIKU }));
    expect(response.status).toBe(401);
    expect(h.core.authorizeCalls[0]?.keySha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(h.orq.calls).toEqual([]);
  });

  it("limits the client address and the project of the key first, and refuses at 429 before the Core is asked", async () => {
    const h = harness();
    h.authLimiter.success = false;
    const response = await h.send(
      post("/v1/chat/completions", { model: HAIKU }, { "cf-connecting-ip": "203.0.113.7" }),
    );
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("60");
    expect(h.authLimiter.keys).toEqual(["203.0.113.7"]);
    expect(h.core.authorizeCalls).toEqual([]);
  });

  it("uses one address bucket even when an attacker changes the unverified project id", async () => {
    const h = harness();
    const other = `omh_ai_01H00000000000000000000799_${"B".repeat(43)}`;
    await h.send(
      post("/v1/chat/completions", { model: HAIKU }, { "cf-connecting-ip": "203.0.113.7" }),
    );
    await h.send(
      new Request("https://ai.test/v1/chat/completions", {
        method: "POST",
        headers: {
          authorization: `Bearer ${other}`,
          "cf-connecting-ip": "203.0.113.7",
          "content-type": "application/json",
        },
        body: JSON.stringify({ model: HAIKU }),
      }),
    );
    expect(h.authLimiter.keys).toEqual(["203.0.113.7", "203.0.113.7"]);
    h.authLimiter.success = false;
    const blocked = await h.send(
      new Request("https://ai.test/v1/models", {
        headers: { authorization: `Bearer ${other}`, "cf-connecting-ip": "203.0.113.7" },
      }),
    );
    expect(blocked.status).toBe(429);
    expect(h.core.authorizeCalls).toHaveLength(2);
  });

  it("refuses a malformed key before the shared address bucket or the Core", async () => {
    const h = harness();
    h.authLimiter.success = false;
    const response = await h.send(
      new Request("https://ai.test/v1/chat/completions", {
        method: "POST",
        headers: { authorization: "Bearer nope", "cf-connecting-ip": "203.0.113.7" },
        body: JSON.stringify({ model: HAIKU }),
      }),
    );
    expect(response.status).toBe(401);
    expect(h.authLimiter.keys).toEqual([]);
    expect(h.core.authorizeCalls).toEqual([]);
  });

  it("shares one bucket for requests without a connecting IP", async () => {
    const h = harness();
    await h.send(post("/v1/chat/completions", { model: HAIKU }));
    expect(h.authLimiter.keys).toEqual(["unknown"]);
  });

  it("limits the project after the key is authorized, and refuses at 429 before admission", async () => {
    const h = harness();
    h.limiter.success = false;
    const response = await h.send(post("/v1/chat/completions", { model: HAIKU }));
    expect(response.status).toBe(429);
    expect(h.limiter.keys).toEqual([expect.any(String)]);
    expect(h.core.admits).toEqual([]);
    expect(h.orq.calls).toEqual([]);
  });

  it("answers 503 ai_unavailable and logs the operation when a limiter fails", async () => {
    const h = harness();
    h.authLimiter.fails = true;
    const response = await h.send(post("/v1/chat/completions", { model: HAIKU }));
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: "ai_unavailable" } });
    expect(linesOf(warn)).toContainEqual({
      event: "ai_gateway_outcome",
      outcome: "binding_unavailable",
      operation: "address_rate_limit",
    });
  });

  it("answers 503 ai_unavailable when the Core cannot authorize the key", async () => {
    const h = harness();
    h.core.authorizeFails = true;
    const response = await h.send(post("/v1/chat/completions", { model: HAIKU }));
    expect(response.status).toBe(503);
    expect(h.orq.calls).toEqual([]);
  });

  it("answers 503 ai_unavailable for a request whose URL cannot be read", async () => {
    const h = harness();
    const broken = {
      url: "not a url",
      method: "GET",
      headers: new Headers(),
    } as unknown as Request;
    const response = await h.send(broken);
    expect(response.status).toBe(503);
    expect(linesOf(warn)).toContainEqual({
      event: "ai_gateway_outcome",
      outcome: "unexpected_error",
    });
  });
});

describe("request bodies", () => {
  it("refuses a JSON route whose body is not application/json with 400", async () => {
    const h = harness();
    const response = await h.send(
      post("/v1/chat/completions", JSON.stringify({ model: HAIKU }), {
        "content-type": "text/plain",
      }),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "invalid_request" } });
    expect(h.orq.calls).toEqual([]);
  });

  it("accepts a JSON content type with parameters", async () => {
    const h = harness();
    h.orq.respond(() => answer("{}", null));
    const response = await h.send(
      post(
        "/v1/chat/completions",
        { model: HAIKU },
        { "content-type": "application/json; charset=utf-8" },
      ),
    );
    expect(response.status).toBe(200);
    await settled(h.ctx, response);
  });

  it.each([
    ["text that is not JSON", "{not json"],
    ["an array", JSON.stringify([{ model: HAIKU }])],
    ["a string", JSON.stringify("model")],
    ["an empty body", ""],
    ["a missing body", null],
    ["a body without model", JSON.stringify({ messages: [] })],
    ["an empty model", JSON.stringify({ model: "" })],
    ["a model that is not a string", JSON.stringify({ model: 7 })],
    ["a model longer than 200 characters", JSON.stringify({ model: "a".repeat(201) })],
  ])("refuses %s with 400 invalid_request", async (_label, text) => {
    const h = harness();
    const response = await h.send(
      text === null
        ? new Request("https://ai.test/v1/chat/completions", {
            method: "POST",
            headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
          })
        : post("/v1/chat/completions", text),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { type: "invalid_request_error" } });
    expect(h.orq.calls).toEqual([]);
    expect(h.core.admits).toEqual([]);
  });

  it("accepts a model of exactly 200 characters", async () => {
    const h = harness();
    h.orq.respond(() => answer("{}", null));
    const response = await h.send(post("/v1/chat/completions", { model: "a".repeat(200) }));
    expect(response.status).toBe(200);
    await settled(h.ctx, response);
  });

  it("refuses duplicate top-level JSON keys and preserves the original numeric bytes", async () => {
    const h = harness();
    h.orq.respond(() => answer("{}", null));
    const response = await h.send(
      post("/v1/chat/completions", '{"model":"mistral/a","model":"openai/b","messages":[]}'),
    );
    expect(response.status).toBe(400);
    expect(h.core.admits).toEqual([]);
    const raw = String.raw`{ "model":"openai/b", "seed":9007199254740993, "temperature":1e400, "messages":[{"role":"user","content":"a\"b{}[]"}], "n":1.0 }`;
    const forwarded = await h.send(post("/v1/chat/completions", raw));
    expect(forwarded.status).toBe(200);
    expect(h.orq.calls[0]?.init.body).toBe(raw);
    await settled(h.ctx, forwarded);
  });

  it("forwards the parsed fields unchanged and sets the orq headers only", async () => {
    const h = harness();
    h.orq.respond(() => answer("{}", null));
    const messages = [{ role: "user", content: "Hi" }];
    const response = await h.send(
      post("/v1/chat/completions", { model: HAIKU, messages, max_tokens: 9 }),
    );
    expect(bodyOf(h.orq.calls[0]?.init)).toEqual({ model: HAIKU, messages, max_tokens: 9 });
    expect(headersOf(h.orq.calls[0]?.init)).toEqual({
      authorization: `Bearer ${ORQ_KEY}`,
      "x-orq-identity-id": h.core.authorizeCalls[0]?.projectId,
      "content-type": "application/json",
    });
    await settled(h.ctx, response);
  });

  it("refuses a JSON body over the limit by its declared length, with 413, before anything else runs", async () => {
    const h = harness();
    const oversized = new Request("https://ai.test/v1/chat/completions", {
      method: "POST",
      headers: {
        authorization: `Bearer ${KEY}`,
        "content-type": "application/json",
        "content-length": String(AI_JSON_BODY_LIMIT + 1),
      },
      body: "{}",
    });
    const response = await h.send(oversized);
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ error: { code: "request_too_large" } });
    expect(h.core.admits).toEqual([]);
    expect(h.orq.calls).toEqual([]);
  });

  it("refuses a JSON body that grows past the limit while it is read, with 413", async () => {
    const h = harness();
    const response = await h.send(
      streamedRequest("/v1/chat/completions", AI_JSON_BODY_LIMIT + 1024 * 1024, "application/json"),
    );
    expect(response.status).toBe(413);
    expect(h.orq.calls).toEqual([]);
  });

  it("refuses a body that fails while it is read with 400", async () => {
    const h = harness();
    const broken = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new Error("socket reset"));
      },
    });
    const request = new Request("https://ai.test/v1/chat/completions", {
      method: "POST",
      headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
      body: broken,
      duplex: "half",
    } as RequestInit);
    const response = await h.send(request);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { message: "The request body could not be read." },
    });
    expect(h.orq.calls).toEqual([]);
  });

  it("refuses excessive JSON objects and primitive array items before allocating a parsed tree, while allowing punctuation inside strings", async () => {
    const h = harness();
    h.orq.respond(() => answer("{}", null));
    for (const item of ["{}", "0"]) {
      const body = '{"model":"a/b","x":[' + `${item},`.repeat(JSON_STRUCTURE_MAX + 1) + item + "]}";
      const response = await h.send(post("/v1/chat/completions", body));
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        error: { message: "The request body has too many JSON values or containers." },
      });
    }
    expect(h.core.admits).toEqual([]);
    const ordinary = await h.send(
      post("/v1/chat/completions", { model: HAIKU, input: "[,{}:]".repeat(JSON_STRUCTURE_MAX) }),
    );
    expect(ordinary.status).toBe(200);
    await settled(h.ctx, ordinary);
  });

  it("refuses a body that stops arriving for the read deadline with 400, before admission", async () => {
    vi.useFakeTimers();
    const h = harness();
    const stalled = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"model":'));
      },
    });
    const response = h.send(
      new Request("https://ai.test/v1/chat/completions", {
        method: "POST",
        headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
        body: stalled,
        duplex: "half",
      } as RequestInit),
    );
    // The key digest is native work, so the body is read only once the Core has authorized the call.
    await vi.waitFor(() => expect(h.core.authorizeCalls).toHaveLength(1));
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(BODY_READ_MS);
    const result = await response;
    expect(result.status).toBe(400);
    expect(await result.json()).toMatchObject({
      error: { message: "The request body was not received in time." },
    });
    expect(h.core.admits).toEqual([]);
  });

  it("refuses a body that trickles on past the total read deadline with 400, though no pause reaches the idle limit", async () => {
    vi.useFakeTimers();
    const h = harness();
    const trickle = new ReadableStream<Uint8Array>({
      async pull(controller) {
        await new Promise((resolve) => setTimeout(resolve, BODY_IDLE_MS / 2));
        controller.enqueue(new TextEncoder().encode(" "));
      },
    });
    const response = h.send(
      new Request("https://ai.test/v1/chat/completions", {
        method: "POST",
        headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
        body: trickle,
        duplex: "half",
      } as RequestInit),
    );
    await vi.waitFor(() => expect(h.core.authorizeCalls).toHaveLength(1));
    await vi.advanceTimersByTimeAsync(BODY_READ_MS);
    const result = await response;
    expect(result.status).toBe(400);
    expect(await result.json()).toMatchObject({
      error: { message: "The request body was not received in time." },
    });
    expect(h.core.admits).toEqual([]);
  });

  it("counts received bytes, so stalled declared lengths do not starve other requests, and frees bytes after a deadline", async () => {
    vi.useFakeTimers();
    const h = harness();
    h.orq.respond(() => answer("{}", null));
    const stalledMultipart = (received: number) =>
      new Request("https://ai.test/v1/audio/transcriptions", {
        method: "POST",
        headers: {
          authorization: `Bearer ${KEY}`,
          "content-type": "multipart/form-data; boundary=x",
          "content-length": String(AI_MULTIPART_BODY_LIMIT),
        },
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array(received));
          },
        }),
        duplex: "half",
      } as RequestInit);
    const slow = h.send(stalledMultipart(12));
    await vi.waitFor(() => expect(h.core.authorizeCalls).toHaveLength(1));
    await vi.advanceTimersByTimeAsync(0);
    const normal = await h.send(post("/v1/chat/completions", { model: HAIKU }));
    expect(normal.status).toBe(200);
    await normal.text();
    await h.ctx.drain();
    await vi.advanceTimersByTimeAsync(BODY_READ_MS);
    expect((await slow).status).toBe(400);

    const first = h.send(stalledMultipart(26 * 1024 * 1024));
    await vi.waitFor(() => expect(h.core.authorizeCalls).toHaveLength(3));
    await vi.advanceTimersByTimeAsync(0);
    const busy = await h.send(post("/v1/chat/completions", { model: HAIKU }));
    expect(busy.status).toBe(503);
    expect(await busy.json()).toMatchObject({ error: { code: "ai_unavailable" } });
    await vi.advanceTimersByTimeAsync(BODY_READ_MS);
    expect((await first).status).toBe(400);
    const after = await h.send(post("/v1/chat/completions", { model: HAIKU }));
    expect(after.status).toBe(200);
    await after.text();
    await h.ctx.drain();
  });

  it("releases the bytes of an upload that stops arriving after the idle limit, before the total deadline", async () => {
    vi.useFakeTimers();
    const h = harness();
    h.orq.respond(() => answer("{}", null));
    const stalled = new Request("https://ai.test/v1/audio/transcriptions", {
      method: "POST",
      headers: {
        authorization: `Bearer ${KEY}`,
        "content-type": "multipart/form-data; boundary=x",
        "content-length": String(AI_MULTIPART_BODY_LIMIT),
      },
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(AI_MULTIPART_BODY_LIMIT));
        },
      }),
      duplex: "half",
    } as RequestInit);
    const slow = h.send(stalled);
    await vi.waitFor(() => expect(h.core.authorizeCalls).toHaveLength(1));
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(BODY_IDLE_MS);
    const normal = await h.send(post("/v1/chat/completions", { model: HAIKU }));
    expect(normal.status).toBe(200);
    await normal.text();
    await h.ctx.drain();
    await vi.advanceTimersByTimeAsync(BODY_READ_MS);
    expect((await slow).status).toBe(400);
  });

  it("limits multipart allocation before FormData parsing and holds decoded bodies until upstream headers", async () => {
    const h = harness();
    const form = new FormData();
    form.append("model", HAIKU);
    for (let part = 0; part < MULTIPART_PARTS_MAX; part += 1) form.append(`part${part}`, "");
    const tooMany = await h.send(multipart("/v1/audio/transcriptions", form));
    expect(tooMany.status).toBe(400);
    expect(await tooMany.json()).toMatchObject({
      error: { message: "The form has too many parts." },
    });
    expect(h.core.admits).toEqual([]);
    const boundary = " x";
    const manyParts =
      Array.from(
        { length: MULTIPART_PARTS_MAX + 1 },
        (_value, index) =>
          `--${boundary}\r\nContent-Disposition: form-data; name="part${index}"\r\n\r\nx\r\n`,
      ).join("") + `--${boundary}--\r\n`;
    const quotedBoundary = await h.send(
      post("/v1/audio/transcriptions", manyParts, {
        "content-type": `multipart/form-data; boundary="${boundary}"`,
      }),
    );
    expect(quotedBoundary.status).toBe(400);
    expect(await quotedBoundary.json()).toMatchObject({
      error: { message: "The form has too many parts." },
    });
    const ambiguousBoundary = await h.send(
      post("/v1/audio/transcriptions", manyParts, {
        "content-type": `multipart/form-data; boundary=x; boundary="${boundary}"`,
      }),
    );
    expect(ambiguousBoundary.status).toBe(400);
    const quotedOtherParameter = await h.send(
      post("/v1/audio/transcriptions", manyParts, {
        "content-type": 'multipart/form-data; foo="; boundary=x"; boundary=" x"',
      }),
    );
    expect(quotedOtherParameter.status).toBe(400);
    const overlongBoundary = await h.send(
      post("/v1/audio/transcriptions", "x", {
        "content-type": `multipart/form-data; boundary=${"x".repeat(71)}`,
      }),
    );
    expect(overlongBoundary.status).toBe(400);
    expect(h.core.admits).toEqual([]);

    let resolveUpstream!: (response: Response) => void;
    h.orq.respond(
      () =>
        new Promise<Response>((resolve) => {
          resolveUpstream = resolve;
        }),
    );
    const large = JSON.stringify({ model: HAIKU, input: "x".repeat(15 * 1024 * 1024) });
    const first = h.send(post("/v1/chat/completions", large));
    await vi.waitFor(() => expect(h.orq.calls).toHaveLength(1));
    const busy = await h.send(post("/v1/chat/completions", large));
    expect(busy.status).toBe(503);
    expect(h.orq.calls).toHaveLength(1);
    resolveUpstream(answer("{}", null));
    const response = await first;
    expect(response.status).toBe(200);
    h.orq.respond(() => answer("{}", null));
    const next = await h.send(post("/v1/chat/completions", large));
    expect(next.status).toBe(200);
    await response.text();
    await settled(h.ctx, next);
  });

  it("refuses a multipart body over its limit with 413", async () => {
    const h = harness();
    const response = await h.send(
      streamedRequest(
        "/v1/audio/transcriptions",
        AI_MULTIPART_BODY_LIMIT + 1024 * 1024,
        "multipart/form-data; boundary=x",
      ),
    );
    expect(response.status).toBe(413);
    expect(h.orq.calls).toEqual([]);
  });

  it.each(EITHER_PATHS)(
    "refuses %s with a content type that is neither JSON nor multipart, with 400",
    async (path) => {
      const h = harness();
      const response = await h.send(
        post(path, JSON.stringify({ model: HAIKU }), { "content-type": "text/plain" }),
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        error: { message: "The request body must be application/json or multipart/form-data." },
      });
      expect(h.orq.calls).toEqual([]);
      expect(h.core.admits).toEqual([]);
    },
  );

  it.each(EITHER_PATHS)("refuses %s without a content type with 400", async (path) => {
    const h = harness();
    const response = await h.send(
      new Request(`https://ai.test${path}`, {
        method: "POST",
        headers: { authorization: `Bearer ${KEY}` },
      }),
    );
    expect(response.status).toBe(400);
    expect(h.orq.calls).toEqual([]);
  });

  it("refuses a JSON route whose body is multipart with 400", async () => {
    const h = harness();
    const response = await h.send(multipart("/v1/chat/completions", formOf([["model", HAIKU]])));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { message: "The request body must be application/json." },
    });
    expect(h.orq.calls).toEqual([]);
  });

  it("refuses a JSON upload body over the JSON limit with 413, under the multipart limit", async () => {
    const h = harness();
    const response = await h.send(
      streamedRequest("/v1/images/edits", AI_JSON_BODY_LIMIT + 1024 * 1024, "application/json"),
    );
    expect(response.status).toBe(413);
    expect(h.orq.calls).toEqual([]);
  });

  it("refuses a multipart form without a model field with 400", async () => {
    const h = harness();
    const response = await h.send(multipart("/v1/audio/transcriptions", formOf([["prompt", "x"]])));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { message: 'The form needs exactly one "model" field.' },
    });
    expect(h.orq.calls).toEqual([]);
  });

  it("refuses a multipart form with two model entries with 400", async () => {
    const h = harness();
    const form = formOf([
      ["model", HAIKU],
      ["model", "openai/whisper"],
    ]);
    const response = await h.send(multipart("/v1/audio/transcriptions", form));
    expect(response.status).toBe(400);
    expect(h.orq.calls).toEqual([]);
    expect(h.core.admits).toEqual([]);
  });

  it("refuses a multipart model that is a file with 400", async () => {
    const h = harness();
    const response = await h.send(
      multipart("/v1/images/edits", formOf([["model", new Blob(["x"]), "model.bin"]])),
    );
    expect(response.status).toBe(400);
    expect(h.orq.calls).toEqual([]);
  });

  it("refuses a multipart content type with a body that is not a form with 400", async () => {
    const h = harness();
    const response = await h.send(
      new Request("https://ai.test/v1/audio/transcriptions", {
        method: "POST",
        headers: {
          authorization: `Bearer ${KEY}`,
          "content-type": "multipart/form-data; boundary=missing",
        },
        body: "not a form",
      }),
    );
    expect(response.status).toBe(400);
    expect(h.orq.calls).toEqual([]);
  });

  it("forwards a multipart form as a new FormData, with the entries that were checked and no original content type", async () => {
    const h = harness();
    h.orq.respond(() => answer(JSON.stringify({ text: "hi" }), null));
    const form = formOf([
      ["model", HAIKU],
      ["prompt", "greeting"],
      ["file", new Blob(["RIFF"], { type: "audio/wav" }), "clip.wav"],
    ]);
    const response = await h.send(multipart("/v1/audio/transcriptions", form));
    expect(response.status).toBe(200);
    const init = h.orq.calls[0]?.init;
    expect(init?.body).toBeInstanceOf(FormData);
    const received = init?.body as FormData;
    expect(received.get("model")).toBe(HAIKU);
    expect(received.get("prompt")).toBe("greeting");
    const file = received.get("file");
    expect(file).toBeInstanceOf(File);
    expect((file as File).name).toBe("clip.wav");
    expect(await (file as File).text()).toBe("RIFF");
    expect(headersOf(init)).toEqual({
      authorization: `Bearer ${ORQ_KEY}`,
      "x-orq-identity-id": h.core.authorizeCalls[0]?.projectId,
    });
    await settled(h.ctx, response);
  });
});

describe("jurisdiction", () => {
  it.each([
    ["mistral/mistral-large"],
    ["aws/eu.anthropic.claude-haiku"],
    ["provider/model-without-region"],
  ])("offers %s to an eu project only from exclusive EU upstream metadata", async (model) => {
    const h = harness("eu");
    h.orq.respond((_init, url) =>
      url.startsWith(CATALOG_URL)
        ? Response.json({ model: { id: model, location: ["eu"] } })
        : answer("{}", null),
    );
    const response = await h.send(post("/v1/chat/completions", { model }));
    expect(response.status).toBe(200);
    expect(h.orq.calls[0]?.url).toBe(
      `${CATALOG_URL}/${model.split("/").map(encodeURIComponent).join("/")}`,
    );
    expect(h.core.admits).toHaveLength(1);
    await settled(h.ctx, response);
  });

  it("refuses mixed, global or US locations regardless of EU tokens and Mistral provider, and fails closed on bad metadata", async () => {
    for (const [model, location] of [
      ["mistral/voxtral-mini-transcribe-3", ["global", "eu", "us"]],
      ["mistral/voxtral", ["us"]],
      ["aws/eu.some-model", ["us"]],
      ["azure/europe-west/gpt", ["global"]],
      ["openai/x", []],
    ] as const) {
      const h = harness("eu");
      h.orq.respond(() => Response.json({ model: { id: model, location } }));
      const response = await h.send(post("/v1/chat/completions", { model }));
      expect(response.status, model).toBe(403);
      expect(await response.json()).toMatchObject({
        error: { code: "model_outside_jurisdiction" },
      });
      expect(h.core.admits).toEqual([]);
      expect(h.orq.calls).toHaveLength(1);
    }
    for (const metadata of [
      { id: "other/model", location: ["eu"] },
      { id: "mistral/x" },
      { id: "mistral/x", location: [7] },
      null,
    ]) {
      const h = harness("eu");
      h.orq.respond(() => Response.json({ model: metadata }));
      const response = await h.send(post("/v1/chat/completions", { model: "mistral/x" }));
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ error: { code: "ai_unavailable" } });
      expect(h.core.admits).toEqual([]);
    }
    const h = harness("eu");
    const model = "mistral/x?redirect=us&model=a/b#fragment";
    h.orq.respond(() => new Response("denied", { status: 404 }));
    expect((await h.send(post("/v1/chat/completions", { model }))).status).toBe(503);
    expect(h.orq.calls[0]?.url).toBe(
      `${CATALOG_URL}/${model.split("/").map(encodeURIComponent).join("/")}`,
    );
  });

  it.each(["eu", "any"] as const)(
    "refuses the orq control keys in a %s project with 400, before admission",
    async (jurisdiction) => {
      const h = harness(jurisdiction);
      for (const key of ORQ_CONTROL_KEYS) {
        const response = await h.send(
          post("/v1/chat/completions", { model: "mistral/x", [key]: {} }),
        );
        expect(response.status, key).toBe(400);
        expect(await response.json(), key).toMatchObject({
          error: { message: ORQ_CONTROL_REFUSED, code: "invalid_request" },
        });
      }
      expect(h.core.admits).toEqual([]);
      expect(h.orq.calls).toEqual([]);
    },
  );

  it.each([
    ["load_balancer", { model: "mistral/x", load_balancer: { type: "weight_based", models: [] } }],
    ["fallbacks", { model: "mistral/x", fallbacks: [{ model: "openai/y" }] }],
    ["orq.fallbacks", { model: "mistral/x", orq: { fallbacks: [{ model: "openai/y" }] } }],
    ["orq.load_balancer", { model: "mistral/x", orq: { load_balancer: {} } }],
    ["orq.identity", { model: "mistral/x", orq: { identity: { id: "other" } } }],
    ["cache", { model: "mistral/x", cache: { type: "exact_match" } }],
    ["timeout", { model: "mistral/x", timeout: { call_timeout: 1 } }],
    ["plugins", { model: "mistral/x", plugins: [] }],
    ["fallback_on_codes", { model: "mistral/x", fallback_on_codes: [429] }],
  ])("refuses the orq field %s to an eu project with 400", async (_label, body) => {
    const h = harness("eu");
    const response = await h.send(post("/v1/chat/completions", body));
    expect(response.status).toBe(400);
    expect(h.orq.calls).toEqual([]);
  });

  it.each([
    ["the EU jurisdiction", "eu"],
    ["an any project", "any"],
  ] as const)("accepts OpenAI cache fields in %s", async (_label, jurisdiction) => {
    const h = harness(jurisdiction);
    h.orq.respond((_init, url) =>
      url.startsWith(CATALOG_URL)
        ? Response.json({ model: { id: "mistral/mistral-large", location: ["eu"] } })
        : answer("{}", null),
    );
    const response = await h.send(
      post("/v1/responses", {
        model: "mistral/mistral-large",
        input: "x",
        prompt_cache_key: "u1",
        prompt_cache_retention: "24h",
      }),
    );
    expect(response.status).toBe(200);
    expect(
      bodyOf(h.orq.calls.find((call) => call.url.endsWith("/responses"))?.init)["prompt_cache_key"],
    ).toBe("u1");
    await settled(h.ctx, response);
  });

  it("refuses an orq control field in a multipart form, in any jurisdiction", async () => {
    const h = harness("any");
    const response = await h.send(
      multipart(
        "/v1/audio/transcriptions",
        formOf([
          ["model", "openai/whisper"],
          ["fallbacks", "x"],
        ]),
      ),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { message: ORQ_CONTROL_REFUSED, code: "invalid_request" },
    });
    expect(h.orq.calls).toEqual([]);
  });

  it("refuses an orq control field in a multipart form to an eu project", async () => {
    const h = harness("eu");
    const response = await h.send(
      multipart(
        "/v1/audio/transcriptions",
        formOf([
          ["model", "mistral/voxtral-mini"],
          ["load_balancer", "{}"],
        ]),
      ),
    );
    expect(response.status).toBe(400);
    expect(h.orq.calls).toEqual([]);
  });
});

describe("admission", () => {
  it("admits the call with the hold of its output-token cap when no limit is sent, the model and a reservation id", async () => {
    const h = harness();
    h.orq.respond(() => answer("{}", null));
    const response = await h.send(post("/v1/chat/completions", { model: HAIKU }));
    expect(h.core.admits).toEqual([
      {
        scope: scopeOf("any"),
        reservationId: "RES1",
        model: HAIKU,
        estimateNanoUsd: AI_TOKEN_HOLD_NANO_USD * BigInt(AI_MAX_OUTPUT_TOKENS),
      },
    ]);
    await settled(h.ctx, response);
  });

  it.each([
    ["a small limit", { model: HAIKU, max_tokens: 9 }, AI_HOLD_NANO_USD],
    [
      "a large limit",
      { model: HAIKU, max_output_tokens: 10_000 },
      AI_TOKEN_HOLD_NANO_USD * 10_000n,
    ],
  ])(
    "holds a call with %s by its requested output tokens, never below the fixed hold",
    async (_name, body, hold) => {
      const h = harness();
      h.orq.respond(() => answer("{}", null));
      const response = await h.send(post("/v1/responses", body));
      expect(h.core.admits).toMatchObject([{ estimateNanoUsd: hold }]);
      await settled(h.ctx, response);
    },
  );

  it("holds a JSON call that generates no output tokens at the fixed hold, and does not read its limit field", async () => {
    const h = harness();
    h.orq.respond(() => answer("{}", null));
    const response = await h.send(
      post("/v1/images/generations", { model: HAIKU, max_tokens: AI_MAX_OUTPUT_TOKENS * 6 }),
    );
    expect(response.status).toBe(200);
    expect(h.core.admits).toMatchObject([{ estimateNanoUsd: AI_HOLD_NANO_USD }]);
    await settled(h.ctx, response);
  });

  it("refuses an output-token limit above the cap with 400 before the Core or orq is asked", async () => {
    const h = harness();
    const response = await h.send(
      post("/v1/chat/completions", {
        model: HAIKU,
        max_completion_tokens: AI_MAX_OUTPUT_TOKENS + 1,
      }),
    );
    expect(response.status).toBe(400);
    expect(h.core.admits).toEqual([]);
    expect(h.orq.calls).toEqual([]);
  });

  it.each([
    ["paid_plan_required", 402, "paid_plan_required"],
    ["insufficient_organization_credits", 402, "insufficient_organization_credits"],
    ["project_budget_exceeded", 429, "project_budget_exceeded"],
    ["too_many_open_calls", 429, "ai_rate_limited"],
    ["unavailable", 503, "ai_unavailable"],
  ] as const)(
    "maps the Core refusal %s to %i %s without calling orq",
    async (denial, status, code) => {
      const h = harness();
      h.core.admission = { admitted: false, denial } as AiAdmitResult;
      const response = await h.send(post("/v1/chat/completions", { model: HAIKU }));
      expect(response.status).toBe(status);
      expect(await response.json()).toMatchObject({ error: { code } });
      expect(h.orq.calls).toEqual([]);
    },
  );

  it("answers a call over the open-call cap 429 with Retry-After 5 and the workspace message", async () => {
    const h = harness();
    h.core.admission = { admitted: false, denial: "too_many_open_calls" };
    const response = await h.send(post("/v1/chat/completions", { model: HAIKU }));
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("5");
    expect(await response.json()).toEqual({
      error: {
        message: "Too many AI calls are running for this workspace. Retry in a moment.",
        type: "rate_limit_error",
        code: "ai_rate_limited",
      },
    });
    expect(h.orq.calls).toEqual([]);
    expect(h.core.releases).toEqual([]);
  });

  it("answers 503 ai_unavailable when the admission call fails", async () => {
    const h = harness();
    h.core.admitFails = true;
    const response = await h.send(post("/v1/chat/completions", { model: HAIKU }));
    expect(response.status).toBe(503);
    expect(h.orq.calls).toEqual([]);
  });
});

describe("orq failures before an answer", () => {
  it("releases the hold and answers 502 when orq cannot be reached", async () => {
    const h = harness();
    h.orq.respond(() => Promise.reject(new TypeError("connect failed")));
    const response = await h.send(post("/v1/chat/completions", { model: HAIKU }));
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      error: {
        message: "The AI provider could not complete the call.",
        type: "server_error",
        code: "ai_upstream_unavailable",
      },
    });
    expect(h.core.releases).toEqual([
      { scope: scopeOf("any"), reservationId: "RES1", reason: "upstream_error" },
    ]);
    expect(h.core.settleCalls).toEqual([]);
  });

  it("aborts orq after the timeout when it sends no headers, then releases and answers 502", async () => {
    vi.useFakeTimers();
    const h = harness();
    h.orq.respond(
      (init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        }),
    );
    const pending = h.send(post("/v1/chat/completions", { model: HAIKU }));
    // The request reads its body before orq is called, so the timer starts only once orq has been called.
    while (h.orq.calls.length === 0) await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(ORQ_TIMEOUT_MS);
    const response = await pending;
    expect(response.status).toBe(502);
    expect(h.core.releases).toEqual([
      { scope: scopeOf("any"), reservationId: "RES1", reason: "upstream_error" },
    ]);
  });

  it.each([500, 503, 418])(
    "releases with upstream_error and answers 502 for an orq status of %i",
    async (status) => {
      const h = harness();
      h.orq.respond(() => new Response("internal details of the workspace", { status }));
      const response = await h.send(post("/v1/chat/completions", { model: HAIKU }));
      expect(response.status).toBe(502);
      const text = await response.text();
      expect(text).not.toContain("workspace");
      expect(h.core.releases).toHaveLength(1);
      expect(h.core.releases[0]?.reason).toBe("upstream_error");
    },
  );

  it("answers 429 ai_rate_limited with orq's Retry-After and releases with rate_limited", async () => {
    const h = harness();
    h.orq.respond(
      () => new Response("slow down", { status: 429, headers: { "retry-after": "12" } }),
    );
    const response = await h.send(post("/v1/chat/completions", { model: HAIKU }));
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("12");
    expect(await response.json()).toMatchObject({ error: { code: "ai_rate_limited" } });
    expect(h.core.releases[0]?.reason).toBe("rate_limited");
  });

  it("answers 429 with a 60 second Retry-After when orq sends none", async () => {
    const h = harness();
    h.orq.respond(() => new Response("slow down", { status: 429 }));
    const response = await h.send(post("/v1/chat/completions", { model: HAIKU }));
    expect(response.headers.get("retry-after")).toBe("60");
  });

  it.each([401, 402, 403])(
    "hides orq's account refusal %i behind a generic 502 and logs it",
    async (status) => {
      const h = harness();
      h.orq.respond(
        () =>
          new Response(
            JSON.stringify({ error: { message: "workspace billing is suspended for org acme" } }),
            { status },
          ),
      );
      const response = await h.send(post("/v1/chat/completions", { model: HAIKU }));
      expect(response.status).toBe(502);
      const text = await response.text();
      expect(text).toBe(
        JSON.stringify({
          error: {
            message: "The AI provider could not complete the call.",
            type: "server_error",
            code: "ai_upstream_unavailable",
          },
        }),
      );
      expect(text).not.toContain("workspace");
      expect(text).not.toContain("acme");
      expect(linesOf(warn)).toContainEqual({
        event: "ai_gateway_outcome",
        outcome: "orq_account_refused",
        projectId: scopeOf("any").projectId,
        reservationId: "RES1",
        status,
      });
      expect(h.core.releases[0]?.reason).toBe("upstream_error");
    },
  );

  it("passes orq's bad request message with its status and a rebuilt body, and releases with invalid_request", async () => {
    const h = harness();
    h.orq.respond(
      () =>
        new Response(
          JSON.stringify({
            error: { message: "messages is required", type: "x", code: "y" },
            extra: "secret",
          }),
          { status: 400 },
        ),
    );
    const response = await h.send(post("/v1/chat/completions", { model: HAIKU }));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: {
        message: "messages is required",
        type: "invalid_request_error",
        code: "invalid_request",
      },
    });
    expect(h.core.releases[0]?.reason).toBe("invalid_request");
  });

  it.each([413, 415, 422])("keeps the status %i of a rejected request", async (status) => {
    const h = harness();
    h.orq.respond(() => Response.json({ error: { message: "rejected" } }, { status }));
    const response = await h.send(post("/v1/chat/completions", { model: HAIKU }));
    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({
      error: { message: "rejected", code: "invalid_request" },
    });
  });

  it("answers an orq 404 as model_not_found with the status 404", async () => {
    const h = harness();
    h.orq.respond(() => Response.json({ error: { message: "no such model" } }, { status: 404 }));
    const response = await h.send(post("/v1/chat/completions", { model: "openai/nope" }));
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: { message: "no such model", type: "invalid_request_error", code: "model_not_found" },
    });
    expect(h.core.releases[0]?.reason).toBe("invalid_request");
  });

  it("cuts orq's message at 500 characters", async () => {
    const h = harness();
    h.orq.respond(() => Response.json({ error: { message: "m".repeat(600) } }, { status: 400 }));
    const response = await h.send(post("/v1/chat/completions", { model: HAIKU }));
    const body = (await response.json()) as { error: { message: string } };
    expect(body.error.message).toHaveLength(500);
  });

  it("answers a fixed message when orq's rejection cannot be read", async () => {
    const h = harness();
    h.orq.respond(() => new Response("not json", { status: 400 }));
    const response = await h.send(post("/v1/chat/completions", { model: HAIKU }));
    expect(await response.json()).toMatchObject({
      error: { message: "The provider rejected the request." },
    });
  });

  it("answers a fixed message when orq's rejection has no message", async () => {
    const h = harness();
    h.orq.respond(() => Response.json({ error: { message: "" } }, { status: 400 }));
    const response = await h.send(post("/v1/chat/completions", { model: HAIKU }));
    expect(await response.json()).toMatchObject({
      error: { message: "The provider rejected the request." },
    });
  });

  it("replaces an orq rejection that names our workspace, credit, key or billing with the fixed message", async () => {
    const h = harness();
    const text =
      "Your credit balance is too low to access the Anthropic API for workspace ohmyhost-prod (key sk-ant-api03-XXXX). Please go to Plans & Billing.";
    h.orq.respond(() => Response.json({ error: { message: text } }, { status: 400 }));
    const response = await h.send(post("/v1/chat/completions", { model: HAIKU }));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { message: "The provider rejected the request.", code: "invalid_request" },
    });
  });

  it("answers 502 when orq's error body cannot be read at all", async () => {
    const h = harness();
    h.orq.respond(() => {
      const broken = new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            controller.error(new Error("socket reset"));
          },
        }),
        { status: 400 },
      );
      return broken;
    });
    const response = await h.send(post("/v1/chat/completions", { model: HAIKU }));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { message: "The provider rejected the request." },
    });
  });

  it("releases the hold when the release call fails and still answers", async () => {
    const h = harness();
    h.core.releaseFails = true;
    h.orq.respond(() => new Response("boom", { status: 500 }));
    const response = await h.send(post("/v1/chat/completions", { model: HAIKU }));
    expect(response.status).toBe(502);
    expect(linesOf(warn)).toContainEqual({
      event: "ai_gateway_outcome",
      outcome: "release_failed",
      projectId: scopeOf("any").projectId,
      reservationId: "RES1",
      reason: "upstream_error",
    });
  });
});

describe("success pass-through", () => {
  it("passes a JSON answer unchanged with only the allowed headers", async () => {
    const h = harness();
    const text = JSON.stringify({ id: "chat-1", choices: [{ message: { content: "Hi" } }] });
    h.orq.respond(() => answer(text, "trace-9"));
    const response = await h.send(post("/v1/chat/completions", { model: HAIKU }));
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(text);
    expect([...response.headers.keys()].sort()).toEqual([
      "cache-control",
      "content-type",
      "x-content-type-options",
    ]);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    await settled(h.ctx, response);
  });

  it("streams a Server-Sent Events answer unchanged", async () => {
    const h = harness();
    const chunks = ['data: {"a":1}\n\n', "data: [DONE]\n\n"];
    h.orq.respond(() => answer(chunks.join(""), "trace-s", "text/event-stream") as Response);
    const response = await h.send(post("/v1/chat/completions", { model: HAIKU, stream: true }));
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(await response.text()).toBe(chunks.join(""));
    await settled(h.ctx, response);
  });

  it("passes a binary answer unchanged", async () => {
    const h = harness();
    const bytes = new Uint8Array([0, 1, 2, 250, 255]);
    h.orq.respond(() => answer(bytes, null, "audio/mpeg"));
    const response = await h.send(post("/v1/audio/speech", { model: "openai/tts-1", input: "hi" }));
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
    expect(response.headers.get("content-type")).toBe("audio/mpeg");
    await settled(h.ctx, response);
  });

  it("answers an answer without a body with its status, and settles it at once", async () => {
    const h = harness();
    h.orq.respond(
      () => new Response(null, { status: 204, headers: { "x-orq-trace-id": "trace-empty" } }),
    );
    const response = await h.send(post("/v1/chat/completions", { model: HAIKU }));
    expect(response.status).toBe(204);
    expect(response.body).toBeNull();
    await settled(h.ctx, response);
    expect(h.core.settleCalls).toHaveLength(1);
    expect(h.core.settleCalls[0]?.traceId).toBe("trace-empty");
  });

  it("does not copy orq's other headers", async () => {
    const h = harness();
    h.orq.respond(
      () =>
        new Response("{}", {
          headers: {
            "content-type": "application/json",
            "x-orq-trace-id": "trace-h",
            "set-cookie": "a=b",
            "x-orq-request-id": "r1",
          },
        }),
    );
    const response = await h.send(post("/v1/chat/completions", { model: HAIKU }));
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get("x-orq-trace-id")).toBeNull();
    expect(response.headers.get("x-orq-request-id")).toBeNull();
    await settled(h.ctx, response);
  });
});

describe("settlement", () => {
  it("settles once with the cost orq recorded for the trace, and the trace id", async () => {
    const h = harness();
    h.orq.respond((_init, url) =>
      url === TELEMETRY_URL ? telemetryReply(3.6e-6) : answer("{}", "trace-7"),
    );
    const response = await h.send(post("/v1/chat/completions", { model: HAIKU }));
    await response.text();
    await settled(h.ctx, response);
    expect(h.core.settleCalls).toEqual([
      {
        scope: scopeOf("any"),
        reservationId: "RES1",
        model: HAIKU,
        costNanoUsd: 3_600n,
        usage: {},
        traceId: "trace-7",
      },
    ]);
  });

  it("prioritizes recorded LLM cost and marks a USD 0.01 fallback only for unusable chat/Responses cost", async () => {
    for (const path of ["/v1/chat/completions", "/v1/responses"]) {
      for (const usd of [0, 1e-9, 3.6e-6]) {
        const h = harness();
        let queries = 0;
        h.orq.respond((_init, url) => {
          if (url !== TELEMETRY_URL) return answer("{}", "trace-7");
          queries += 1;
          return queries === 1 ? telemetryReply(usd) : Response.json({ data: [] });
        });
        const response = await h.send(post(path, { model: HAIKU }));
        await settled(h.ctx, response);
        expect(h.core.settleCalls).toEqual([
          {
            scope: scopeOf("any"),
            reservationId: "RES1",
            model: HAIKU,
            costNanoUsd: BigInt(Math.round(usd * 1e9)),
            usage: {},
            traceId: "trace-7",
          },
        ]);
        expect(queries).toBe(usd === 0 ? 5 : 1);
        expect(h.core.releases).toEqual([]);
        expect(h.orq.calls.filter((call) => call.url !== TELEMETRY_URL)).toHaveLength(1);
      }
    }
    expect(linesOf(warn)).toEqual([]);
    for (const path of [...JSON_PATHS, ...EITHER_PATHS]) {
      const llm = path === "/v1/chat/completions" || path === "/v1/responses";
      for (const failure of ["absent trace", "missing scalar", "unusable scalar", "unavailable"]) {
        warn.mockClear();
        const h = harness();
        const traceId = failure === "absent trace" ? null : "trace-fallback";
        h.orq.respond((_init, url) => {
          if (url !== TELEMETRY_URL) return answer("data: done\n\n", traceId, "text/event-stream");
          if (failure === "unavailable") return new Response(null, { status: 503 });
          if (failure === "unusable scalar") return telemetryReply(-1);
          return Response.json({ data: [] });
        });
        const response = await h.send(post(path, { model: HAIKU, private_input: "never logged" }));
        expect(response.status).toBe(200);
        await settled(h.ctx, response);
        expect(h.core.settleCalls).toEqual([
          {
            scope: scopeOf("any"),
            reservationId: "RES1",
            model: HAIKU,
            costNanoUsd: llm ? 10_000_000n : 0n,
            usage: llm ? { fallback_nano_usd: 10_000_000 } : {},
            traceId,
          },
        ]);
        expect(h.waits).toHaveLength(traceId === null ? 0 : 4);
        expect(h.orq.calls.filter((call) => call.url === TELEMETRY_URL)).toHaveLength(
          traceId === null ? 0 : 5,
        );
        expect(h.orq.calls.filter((call) => call.url !== TELEMETRY_URL)).toHaveLength(1);
        expect(h.core.releases).toEqual([]);
        expect(linesOf(warn)).toEqual([
          {
            event: "ai_gateway_outcome",
            outcome: llm ? "llm_cost_fallback" : "cost_unmeasured",
            projectId: scopeOf("any").projectId,
            reservationId: "RES1",
            model: HAIKU,
            traceId: traceId ?? "none",
            ...(llm ? { fallbackNanoUsd: "10000000" } : {}),
          },
        ]);
      }
    }
    expect(JSON.stringify(linesOf(warn))).not.toContain("never logged");
  });

  it("treats a trace id longer than 256 characters as absent", async () => {
    const h = harness();
    h.orq.respond(() => answer("{}", "t".repeat(257)));
    const response = await h.send(post("/v1/chat/completions", { model: HAIKU }));
    await response.text();
    await settled(h.ctx, response);
    expect(h.core.settleCalls[0]).toMatchObject({
      costNanoUsd: 10_000_000n,
      usage: { fallback_nano_usd: 10_000_000 },
      traceId: null,
    });
    expect(h.orq.calls.some((call) => call.url === TELEMETRY_URL)).toBe(false);
  });

  it("settles an LLM call whose trace has no cost at USD 0.01 and logs llm_cost_fallback", async () => {
    const h = harness();
    h.orq.respond((_init, url) =>
      url === TELEMETRY_URL ? Response.json({ data: [] }) : answer("{}", "trace-z"),
    );
    const response = await h.send(post("/v1/responses", { model: "openai/gpt-5", input: "x" }));
    await response.text();
    await settled(h.ctx, response);
    expect(h.core.settleCalls[0]).toMatchObject({
      costNanoUsd: 10_000_000n,
      usage: { fallback_nano_usd: 10_000_000 },
      traceId: "trace-z",
    });
    expect(h.waits).toHaveLength(4);
    expect(linesOf(warn)).toContainEqual(
      expect.objectContaining({ outcome: "llm_cost_fallback", traceId: "trace-z" }),
    );
  });

  it("charges a measured speech cost of zero as zero regardless of Unicode input", async () => {
    const h = harness();
    h.orq.respond((_init, url) =>
      url === TELEMETRY_URL
        ? telemetryReply(0)
        : answer(new Uint8Array([1, 2]), "trace-tts", "audio/mpeg"),
    );
    const response = await h.send(
      post("/v1/audio/speech", { model: "openai/tts-1", input: "hé😀llo" }),
    );
    await response.arrayBuffer();
    await settled(h.ctx, response);
    expect(h.core.settleCalls[0]).toMatchObject({ costNanoUsd: 0n, traceId: "trace-tts" });
    expect(h.core.settleCalls).toHaveLength(1);
    expect(h.core.releases).toEqual([]);
    expect(linesOf(warn)).not.toContainEqual(
      expect.objectContaining({ outcome: "cost_unmeasured" }),
    );
  });

  it("settles a speech call with no trace id at zero without guessing a charge", async () => {
    const h = harness();
    h.orq.respond(() => answer(new Uint8Array([1]), null, "audio/mpeg"));
    const response = await h.send(
      post("/v1/audio/speech", { model: "openai/tts-1", input: "héllo" }),
    );
    await response.arrayBuffer();
    await settled(h.ctx, response);
    expect(h.core.settleCalls[0]).toMatchObject({
      costNanoUsd: 0n,
      traceId: null,
    });
    expect(linesOf(warn)).toContainEqual(expect.objectContaining({ outcome: "cost_unmeasured" }));
  });

  it("keeps the measured speech cost when it is not zero", async () => {
    const h = harness();
    h.orq.respond((_init, url) =>
      url === TELEMETRY_URL
        ? telemetryReply(0.00002)
        : answer(new Uint8Array([1]), "trace-m", "audio/mpeg"),
    );
    const response = await h.send(
      post("/v1/audio/speech", { model: "openai/tts-1", input: "hello" }),
    );
    await response.arrayBuffer();
    await settled(h.ctx, response);
    expect(h.core.settleCalls[0]?.costNanoUsd).toBe(20_000n);
  });

  it("settles a speech call without a string input at zero and logs cost_unmeasured", async () => {
    const h = harness();
    h.orq.respond(() => answer(new Uint8Array([1]), null, "audio/mpeg"));
    const response = await h.send(post("/v1/audio/speech", { model: "openai/tts-1", input: 5 }));
    await response.arrayBuffer();
    await settled(h.ctx, response);
    expect(h.core.settleCalls[0]?.costNanoUsd).toBe(0n);
    expect(linesOf(warn)).toContainEqual(expect.objectContaining({ outcome: "cost_unmeasured" }));
  });

  it("settles a stream once when the client reads it to the end", async () => {
    const h = harness();
    const { body } = sseBody(["data: 1\n\n", "data: 2\n\n"]);
    h.orq.respond(() => answer(body as unknown as BodyInit, "trace-f", "text/event-stream"));
    const response = await h.send(post("/v1/chat/completions", { model: HAIKU, stream: true }));
    await response.text();
    await settled(h.ctx, response);
    expect(h.core.settleCalls).toHaveLength(1);
    expect(h.core.settleCalls[0]?.traceId).toBe("trace-f");
  });

  it("aborts an answer that stalls past the idle limit, and settles it once", async () => {
    vi.useFakeTimers();
    const h = harness();
    h.orq.respond((init, url) =>
      url === TELEMETRY_URL
        ? telemetryReply(0)
        : new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                init.signal?.addEventListener("abort", () =>
                  controller.error(new DOMException("aborted", "AbortError")),
                );
              },
            }),
            { status: 200, headers: { "x-orq-trace-id": "trace-stall" } },
          ),
    );
    const response = await h.send(post("/v1/chat/completions", { model: HAIKU, stream: true }));
    const text = response.text().catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(STREAM_IDLE_MS);
    expect(await text).toBeInstanceOf(Error);
    await h.ctx.drain();
    expect(h.core.settleCalls).toHaveLength(1);
    expect(h.core.settleCalls[0]?.traceId).toBe("trace-stall");
  });

  it("settles once and cancels orq when the client cancels mid-stream", async () => {
    const h = harness();
    const { body, cancels } = sseBody(["data: 1\n\n", "data: 2\n\n", "data: 3\n\n"]);
    h.orq.respond(() => answer(body as unknown as BodyInit, "trace-c", "text/event-stream"));
    const response = await h.send(post("/v1/chat/completions", { model: HAIKU, stream: true }));
    const reader = response.body?.getReader();
    await reader?.read();
    await reader?.cancel();
    await settled(h.ctx, response);
    expect(cancels.count).toBe(1);
    expect(h.core.settleCalls).toHaveLength(1);
    expect(h.core.settleCalls[0]?.traceId).toBe("trace-c");
  });

  it("schedules no stream timer for a chunk read after the answer has settled", async () => {
    vi.useFakeTimers();
    const h = harness();
    const { body } = sseBody(["data: 1\n\n", "data: 2\n\n", "data: 3\n\n"]);
    h.orq.respond((_init, url) =>
      url === TELEMETRY_URL
        ? telemetryReply(0)
        : answer(body as unknown as BodyInit, "trace-late", "text/event-stream"),
    );
    const controller = new AbortController();
    const response = await h.send(
      new Request("https://ai.test/v1/chat/completions", {
        method: "POST",
        headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
        body: JSON.stringify({ model: HAIKU, stream: true }),
        signal: controller.signal,
      }),
    );
    const reader = response.body?.getReader();
    await reader?.read();
    controller.abort();
    await h.ctx.drain();
    expect(vi.getTimerCount()).toBe(0);
    await reader?.read();
    expect(vi.getTimerCount()).toBe(0);
    expect(h.core.settleCalls).toHaveLength(1);
  });

  it("settles once when the client aborts before the answer is read, and cancels orq", async () => {
    const h = harness();
    const { body } = sseBody(["data: 1\n\n", "data: 2\n\n"]);
    h.orq.respond(() => answer(body as unknown as BodyInit, "trace-a", "text/event-stream"));
    const controller = new AbortController();
    const response = await h.send(
      new Request("https://ai.test/v1/chat/completions", {
        method: "POST",
        headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
        body: JSON.stringify({ model: HAIKU, stream: true }),
        signal: controller.signal,
      }),
    );
    expect(response.status).toBe(200);
    controller.abort();
    await settled(h.ctx, response);
    expect(h.core.settleCalls).toHaveLength(1);
    expect(h.core.settleCalls[0]?.traceId).toBe("trace-a");
  });

  it("settles once with the recorded cost when the client leaves while orq is still answering", async () => {
    const h = harness();
    const controller = new AbortController();
    h.orq.respond((_init, url) => {
      if (url === TELEMETRY_URL) return telemetryReply(0.5);
      controller.abort();
      return answer("{}", "trace-n");
    });
    const response = await h.send(
      new Request("https://ai.test/v1/chat/completions", {
        method: "POST",
        headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
        body: JSON.stringify({ model: HAIKU }),
        signal: controller.signal,
      }),
    );
    expect(response.status).toBe(499);
    await settled(h.ctx, response);
    expect(h.core.settleCalls).toHaveLength(1);
    expect(h.core.settleCalls[0]?.costNanoUsd).toBe(500_000_000n);
    expect(h.core.settleCalls[0]?.traceId).toBe("trace-n");
  });

  it("keeps the invocation alive from admission until a refused call is released", async () => {
    const h = harness();
    h.orq.respond(() => new Response("{}", { status: 500 }));
    const response = await h.send(post("/v1/chat/completions", { model: HAIKU }));
    expect(response.status).toBe(502);
    expect(h.ctx.pending).toHaveLength(1);
    await h.ctx.drain();
    expect(h.core.releases).toHaveLength(1);
  });

  it("retries a failed settlement, then settles on the third try", async () => {
    vi.useRealTimers();
    const h = harness();
    h.core.settleFailures = 2;
    h.orq.respond(() => answer("{}", null));
    const response = await h.send(post("/v1/chat/completions", { model: HAIKU }));
    await response.text();
    await settled(h.ctx, response);
    expect(h.core.settleCalls).toHaveLength(3);
    expect(linesOf(warn).some((line) => line["outcome"] === "settle_failed")).toBe(false);
  });

  it("logs settle_failed with the cost and the trace after three failed settlements", async () => {
    const h = harness();
    h.core.settleFailures = 3;
    h.orq.respond((_init, url) =>
      url === TELEMETRY_URL ? telemetryReply(2e-6) : answer("{}", "trace-x"),
    );
    const response = await h.send(post("/v1/chat/completions", { model: HAIKU }));
    await response.text();
    await settled(h.ctx, response);
    expect(h.core.settleCalls).toHaveLength(3);
    expect(linesOf(warn)).toContainEqual({
      event: "ai_gateway_outcome",
      outcome: "settle_failed",
      projectId: scopeOf("any").projectId,
      reservationId: "RES1",
      costNanoUsd: "2000",
      model: HAIKU,
      traceId: "trace-x",
    });
  });
});

describe("GET /v1/models", () => {
  function modelsRequest(): Request {
    return new Request("https://ai.test/v1/models", {
      headers: { authorization: `Bearer ${KEY}` },
    });
  }

  const ORQ_MODELS = {
    object: "list",
    data: [
      { id: "mistral/mistral-large", object: "model", owned_by: "mistral" },
      { id: "openai/gpt-4o", object: "model", owned_by: "openai" },
      { id: "aws/eu.anthropic.claude-haiku", object: "model", owned_by: "aws" },
      { object: "model" },
      "not a record",
    ],
  };

  it("lists the orq models that the eu jurisdiction may call", async () => {
    const h = harness("eu");
    const catalog = {
      object: "list",
      has_more: false,
      data: [
        { id: "mistral/mistral-large", location: ["global", "eu", "us"] },
        { id: "openai/gpt-4o", location: ["eu"] },
        { id: "aws/eu.anthropic.claude-haiku", location: ["us"] },
        { id: "not-enabled/eu-model", location: ["eu"] },
      ],
    };
    h.orq.respond((_init, url) =>
      Response.json(url.startsWith(CATALOG_URL) ? catalog : ORQ_MODELS),
    );
    const response = await h.send(modelsRequest());
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      object: "list",
      data: [ORQ_MODELS.data[1]],
    });
    expect(h.orq.calls[0]?.url).toBe(`${ORQ_BASE_URL}/models`);
    expect(h.orq.calls[0]?.init.method).toBe("GET");
    expect(headersOf(h.orq.calls[0]?.init)).toEqual({ authorization: `Bearer ${ORQ_KEY}` });
    expect(h.core.admits).toEqual([]);
    expect(h.orq.calls[1]?.url).toBe(`${CATALOG_URL}?location=eu`);
    for (const invalid of [
      { ...catalog, has_more: true },
      { ...catalog, has_more: undefined },
      { ...catalog, data: [{ id: "a/b" }] },
      {
        ...catalog,
        data: [
          { id: "a/b", location: ["eu"] },
          { id: "a/b", location: ["us"] },
        ],
      },
    ]) {
      const failed = harness("eu");
      failed.orq.respond((_init, url) =>
        Response.json(url.startsWith(CATALOG_URL) ? invalid : ORQ_MODELS),
      );
      expect((await failed.send(modelsRequest())).status).toBe(503);
    }
  });

  it("lists every orq model to an any project", async () => {
    const h = harness("any");
    h.orq.respond(() => Response.json(ORQ_MODELS));
    const response = await h.send(modelsRequest());
    expect(await response.json()).toEqual({
      object: "list",
      data: [ORQ_MODELS.data[0], ORQ_MODELS.data[1], ORQ_MODELS.data[2]],
    });
  });

  it.each([
    ["an orq error", () => new Response("no", { status: 500 })],
    ["an answer that is not JSON", () => new Response("{", { status: 200 })],
    ["an answer without a data list", () => Response.json({ object: "list" })],
    ["a network error", () => Promise.reject(new TypeError("connect failed"))],
  ])("answers 502 ai_upstream_unavailable on %s", async (_label, reply) => {
    const h = harness();
    h.orq.respond(reply);
    const response = await h.send(modelsRequest());
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ error: { code: "ai_upstream_unavailable" } });
  });

  it("refuses a models request without a key", async () => {
    const h = harness();
    const response = await h.send(new Request("https://ai.test/v1/models"));
    expect(response.status).toBe(401);
    expect(h.orq.calls).toEqual([]);
  });
});

describe("sweep", () => {
  it("releases the reservations older than 15 minutes, at most 200 per run, and logs the count", async () => {
    const h = harness();
    h.core.sweepReleased = 4;
    const gateway = createAiGateway({
      runtime: h.core,
      orq: { fetch: h.orq.fetch, apiKey: ORQ_KEY, baseUrl: ORQ_BASE_URL },
      limiter: h.limiter,
      authLimiter: h.authLimiter,
      newReservationId: () => "RES",
      wait: async () => undefined,
    });
    await gateway.scheduled();
    expect(h.core.sweeps).toEqual([{ olderThanMs: SWEEP_OLDER_THAN_MS, limit: 200 }]);
    expect(log).toHaveBeenCalledWith(JSON.stringify({ event: "ai_gateway_sweep", released: 4 }));
  });

  it("does not log an empty sweep", async () => {
    const h = harness();
    h.core.sweepReleased = 0;
    const gateway = createAiGateway({
      runtime: h.core,
      orq: { fetch: h.orq.fetch, apiKey: ORQ_KEY, baseUrl: ORQ_BASE_URL },
      limiter: h.limiter,
      authLimiter: h.authLimiter,
      newReservationId: () => "RES",
      wait: async () => undefined,
    });
    await gateway.scheduled();
    expect(log).not.toHaveBeenCalled();
  });

  it("logs a closed token and rethrows when the sweep fails", async () => {
    const h = harness();
    h.core.sweepFails = true;
    const gateway = createAiGateway({
      runtime: h.core,
      orq: { fetch: h.orq.fetch, apiKey: ORQ_KEY, baseUrl: ORQ_BASE_URL },
      limiter: h.limiter,
      authLimiter: h.authLimiter,
      newReservationId: () => "RES",
      wait: async () => undefined,
    });
    await expect(gateway.scheduled()).rejects.toThrow("core unreachable");
    expect(warn).toHaveBeenCalledWith(
      JSON.stringify({ event: "ai_gateway_sweep", outcome: "sweep_failed" }),
    );
  });
});
