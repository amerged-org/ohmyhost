import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AI_HOLD_NANO_USD,
  AI_REALTIME_IDLE_MS,
  type AiAdmitResult,
  type AiJurisdiction,
} from "@ohmyhost/platform";
import { createAiGateway, ORQ_TIMEOUT_MS } from "../src/gateway.js";
import {
  FakeCore,
  FakeLimiter,
  FakeOrq,
  FakeSocket,
  FakeWebSocketPair,
  KEY,
  ORQ_BASE_URL,
  ORQ_KEY,
  PROJECT_ID,
  TELEMETRY_URL,
  UpgradeResponse,
  fakeContext,
  headersOf,
  scopeOf,
  telemetryReply,
  upgradeAnswer,
} from "./fakes.js";

/*
 * The realtime voice route. These are deterministic transport tests; a real hosted session passed on Development and
 * Production on 16 November 2026 (docs/plan/evidence/W36/20261116-release-0.1.59.json).
 */

const MODEL = "xai/grok-voice-3.0";
const QUERY = `?model=${encodeURIComponent(MODEL)}`;
const UPSTREAM_URL = `${ORQ_BASE_URL}/realtime?model=${encodeURIComponent(MODEL)}`;
/** The W3C traceparent of the upgrade: version 00, a 16-byte trace id, an 8-byte parent span id, sampled. */
const TRACEPARENT = /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/u;

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

let upstream: FakeSocket;

/** A realtime request with the key and the upgrade header a client sends. */
function realtimeRequest(query: string = QUERY, headers: Record<string, string> = {}): Request {
  return new Request(`https://ai.test/v1/realtime${query}`, {
    headers: { authorization: `Bearer ${KEY}`, upgrade: "websocket", ...headers },
  });
}

/** orq accepts the upgrade with the upstream socket; the telemetry query answers the given cost. */
function acceptUpgrade(h: Harness, traceId: string | null = "trace-rt", usd = 0.0001): void {
  h.orq.respond((_init, url) => {
    if (url.startsWith("https://my.orq.ai/v2/model-catalog/")) {
      const id = decodeURIComponent(url.slice("https://my.orq.ai/v2/model-catalog/".length));
      return Response.json({
        model: { id, location: id === "mistral/voxtral-realtime" ? ["eu"] : ["us"] },
      });
    }
    return url === TELEMETRY_URL ? telemetryReply(usd) : upgradeAnswer(upstream, traceId);
  });
}

/** The traceparent header of the upgrade the gateway sent to orq. */
function sentTraceparent(h: Harness): string {
  return headersOf(h.orq.calls[0]?.init)["traceparent"] ?? "";
}

/** The trace id of the traceparent header the gateway sent to orq. */
function sentTraceId(h: Harness): string {
  return sentTraceparent(h).split("-")[1] ?? "";
}

/** The pair of the last session: `client` is returned to the customer, `server` is the gateway's end. */
function pairOf(): { client: FakeSocket; server: FakeSocket } {
  const pair = FakeWebSocketPair.created.at(-1);
  if (pair === undefined) throw new Error("no session was opened");
  return { client: pair[0], server: pair[1] };
}

/** Lets every settlement the session scheduled finish. */
async function settled(h: Harness): Promise<void> {
  await h.ctx.drain();
}

beforeEach(() => {
  upstream = new FakeSocket();
  FakeWebSocketPair.created.length = 0;
  vi.stubGlobal("Response", UpgradeResponse);
  vi.stubGlobal("WebSocketPair", FakeWebSocketPair);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("request checks", () => {
  it("answers a GET without an Upgrade header with 400 invalid_request, after the key is authorized", async () => {
    const h = harness();
    acceptUpgrade(h);
    const response = await h.send(
      new Request(`https://ai.test/v1/realtime${QUERY}`, {
        headers: { authorization: `Bearer ${KEY}` },
      }),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: {
        message: "The realtime route needs a WebSocket upgrade.",
        type: "invalid_request_error",
        code: "invalid_request",
      },
    });
    expect(h.core.authorizeCalls).toHaveLength(1);
    expect(h.core.admits).toEqual([]);
    expect(h.orq.calls).toEqual([]);
  });

  it("refuses an upgrade to another protocol with 400", async () => {
    const h = harness();
    acceptUpgrade(h);
    const response = await h.send(realtimeRequest(QUERY, { upgrade: "h2c" }));
    expect(response.status).toBe(400);
    expect(h.orq.calls).toEqual([]);
  });

  it.each([
    [""],
    ["?"],
    ["?model="],
    ["?stream=1"],
    ["?model=xai%2Fgrok-voice-3.0&stream=1"],
    ["?model=a&model=b"],
    [`?model=${"a".repeat(201)}`],
    ["?MODEL=xai%2Fgrok-voice-3.0"],
  ])("refuses the query %j with 400 invalid_request, before admission", async (query) => {
    const h = harness();
    acceptUpgrade(h);
    const response = await h.send(realtimeRequest(query));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "invalid_request" } });
    expect(h.core.admits).toEqual([]);
    expect(h.orq.calls).toEqual([]);
  });

  it("accepts a model of exactly 200 characters", async () => {
    const h = harness();
    const model = "a".repeat(200);
    acceptUpgrade(h);
    const response = await h.send(realtimeRequest(`?model=${model}`));
    expect(response.status).toBe(101);
    expect(h.orq.calls[0]?.url).toBe(`${ORQ_BASE_URL}/realtime?model=${model}`);
  });

  it("answers 401 for a missing key before the upgrade and the query are checked", async () => {
    const h = harness();
    const response = await h.send(new Request(`https://ai.test/v1/realtime?stream=1`));
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: { code: "invalid_api_key" } });
    expect(h.orq.calls).toEqual([]);
  });

  it("limits the client address and the project of the key before the Core is asked", async () => {
    const h = harness();
    h.authLimiter.success = false;
    const response = await h.send(realtimeRequest());
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("60");
    expect(h.core.authorizeCalls).toEqual([]);
  });

  it("limits the project once the key is authorized, and refuses before admission", async () => {
    const h = harness();
    h.limiter.success = false;
    const response = await h.send(realtimeRequest());
    expect(response.status).toBe(429);
    expect(h.core.admits).toEqual([]);
    expect(h.orq.calls).toEqual([]);
  });

  it("refuses a model outside the eu jurisdiction with 403, before admission", async () => {
    const h = harness("eu");
    acceptUpgrade(h);
    const response = await h.send(realtimeRequest());
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      error: { code: "model_outside_jurisdiction" },
    });
    expect(h.core.admits).toEqual([]);
    expect(h.orq.calls).toHaveLength(1);
    expect(h.orq.calls[0]?.url).toBe(
      `https://my.orq.ai/v2/model-catalog/${MODEL.split("/").map(encodeURIComponent).join("/")}`,
    );
  });

  it("offers an eu model to an eu project", async () => {
    const h = harness("eu");
    acceptUpgrade(h);
    const response = await h.send(realtimeRequest("?model=mistral%2Fvoxtral-realtime"));
    expect(response.status).toBe(101);
  });
});

describe("admission", () => {
  it("admits the call with the fixed hold, the model and a reservation id", async () => {
    const h = harness();
    acceptUpgrade(h);
    await h.send(realtimeRequest());
    expect(h.core.admits).toEqual([
      {
        scope: scopeOf("any"),
        reservationId: "RES1",
        model: MODEL,
        estimateNanoUsd: AI_HOLD_NANO_USD,
      },
    ]);
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
      const response = await h.send(realtimeRequest());
      expect(response.status).toBe(status);
      expect(await response.json()).toMatchObject({ error: { code } });
      expect(h.orq.calls).toEqual([]);
    },
  );

  it("answers 503 ai_unavailable when the admission call fails", async () => {
    const h = harness();
    h.core.admitFails = true;
    const response = await h.send(realtimeRequest());
    expect(response.status).toBe(503);
    expect(h.orq.calls).toEqual([]);
  });
});

describe("upstream connection", () => {
  it("opens orq's realtime route with the encoded model, the gateway key and the project", async () => {
    const h = harness();
    acceptUpgrade(h);
    await h.send(realtimeRequest());
    expect(h.orq.calls).toHaveLength(1);
    expect(h.orq.calls[0]?.url).toBe(UPSTREAM_URL);
    expect(h.orq.calls[0]?.init.method).toBe("GET");
    expect(h.orq.calls[0]?.init.redirect).toBe("manual");
    const { traceparent, ...headers } = headersOf(h.orq.calls[0]?.init);
    expect(headers).toEqual({
      upgrade: "websocket",
      authorization: `Bearer ${ORQ_KEY}`,
      "x-orq-identity-id": PROJECT_ID,
    });
    expect(traceparent).toMatch(TRACEPARENT);
  });

  it("sends a fresh W3C traceparent with the upgrade, and settles the session with the same trace id", async () => {
    const h = harness();
    acceptUpgrade(h);
    await h.send(realtimeRequest());
    const traceparent = sentTraceparent(h);
    expect(traceparent).toMatch(TRACEPARENT);
    pairOf().server.peerClose(1000);
    await settled(h);
    expect(h.core.settleCalls[0]?.traceId).toBe(traceparent.split("-")[1]);
  });

  it("generates a different trace id for each session", async () => {
    const first = harness();
    acceptUpgrade(first);
    await first.send(realtimeRequest());
    const second = harness();
    acceptUpgrade(second);
    await second.send(realtimeRequest());
    const ids = [first, second].map((h) => sentTraceId(h));
    expect(ids[0]).toMatch(/^[0-9a-f]{32}$/u);
    expect(ids[1]).not.toBe(ids[0]);
  });

  it("ignores the x-orq-trace-id of the upgrade answer, because orq records the traceparent it was sent", async () => {
    const h = harness();
    acceptUpgrade(h, "trace-from-orq", 0.0001);
    await h.send(realtimeRequest());
    const traceparent = sentTraceparent(h);
    pairOf().server.peerClose(1000);
    await settled(h);
    expect(h.core.settleCalls[0]?.traceId).toBe(traceparent.split("-")[1]);
    expect(h.core.settleCalls[0]?.traceId).not.toBe("trace-from-orq");
  });

  it("answers 101 with the customer socket, and accepts both sides", async () => {
    const h = harness();
    acceptUpgrade(h);
    const response = await h.send(realtimeRequest());
    const { client, server } = pairOf();
    expect(response.status).toBe(101);
    expect(response.webSocket).toBe(client);
    expect(server.accepted).toBe(true);
    expect(upstream.accepted).toBe(true);
  });

  it.each([
    [429, 429, "rate_limited", "ai_rate_limited"],
    [400, 400, "invalid_request", "invalid_request"],
    [404, 404, "invalid_request", "model_not_found"],
    [422, 422, "invalid_request", "invalid_request"],
    [401, 502, "upstream_error", "ai_upstream_unavailable"],
    [402, 502, "upstream_error", "ai_upstream_unavailable"],
    [403, 502, "upstream_error", "ai_upstream_unavailable"],
    [418, 502, "upstream_error", "ai_upstream_unavailable"],
    [500, 502, "upstream_error", "ai_upstream_unavailable"],
    [200, 502, "upstream_error", "ai_upstream_unavailable"],
  ] as const)(
    "answers orq's %i without an upgrade as %i and releases the hold as %s",
    async (orqStatus, status, reason, code) => {
      const h = harness();
      h.orq.respond(
        () =>
          new Response(JSON.stringify({ error: { message: "Model is not on realtime" } }), {
            status: orqStatus,
          }),
      );
      const response = await h.send(realtimeRequest());
      expect(response.status).toBe(status);
      expect(await response.json()).toMatchObject({ error: { code } });
      expect(h.core.releases).toEqual([{ scope: scopeOf("any"), reservationId: "RES1", reason }]);
      await settled(h);
    },
  );

  it("keeps the retry-after of orq on a 429 refusal", async () => {
    const h = harness();
    h.orq.respond(() => new Response("{}", { status: 429, headers: { "retry-after": "12" } }));
    const response = await h.send(realtimeRequest());
    expect(response.headers.get("retry-after")).toBe("12");
  });

  it("passes orq's bad request message with the status and a fixed message when it names the account", async () => {
    const h = harness();
    h.orq.respond(
      () =>
        new Response(JSON.stringify({ error: { message: "Model is not on realtime" } }), {
          status: 400,
        }),
    );
    const first = await h.send(realtimeRequest());
    expect(await first.json()).toMatchObject({ error: { message: "Model is not on realtime" } });

    h.orq.respond(
      () =>
        new Response(JSON.stringify({ error: { message: "Workspace credit is empty" } }), {
          status: 400,
        }),
    );
    const second = await h.send(realtimeRequest());
    expect(await second.json()).toMatchObject({
      error: { message: "The provider rejected the request." },
    });
  });

  it("releases the hold and answers 502 when orq cannot be reached", async () => {
    const h = harness();
    h.orq.respond(() => Promise.reject(new TypeError("connect failed")));
    const response = await h.send(realtimeRequest());
    expect(response.status).toBe(502);
    expect(h.core.releases).toEqual([
      { scope: scopeOf("any"), reservationId: "RES1", reason: "upstream_error" },
    ]);
    await settled(h);
  });

  it("releases the hold and answers 502 when orq's refusal body cannot be read", async () => {
    const h = harness();
    h.orq.respond(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.error(new Error("body lost"));
            },
          }),
          { status: 500 },
        ),
    );
    const response = await h.send(realtimeRequest());
    expect(response.status).toBe(502);
    expect(h.core.releases).toHaveLength(1);
    await settled(h);
  });

  it("aborts orq after the timeout when it sends no answer, then releases and answers 502", async () => {
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
    const pending = h.send(realtimeRequest());
    // The timer starts only once orq has been called, after the key is authorized and the call admitted.
    while (h.orq.calls.length === 0) await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(ORQ_TIMEOUT_MS);
    const response = await pending;
    expect(response.status).toBe(502);
    expect(h.core.releases).toHaveLength(1);
    await settled(h);
  });

  it("releases the hold when the release call fails and still answers", async () => {
    const h = harness();
    h.core.releaseFails = true;
    h.orq.respond(() => new Response("{}", { status: 500 }));
    const response = await h.send(realtimeRequest());
    expect(response.status).toBe(502);
    await settled(h);
  });
});

describe("messages", () => {
  it("pumps text and binary messages both ways, unchanged", async () => {
    const h = harness();
    acceptUpgrade(h);
    await h.send(realtimeRequest());
    const { server } = pairOf();
    const up = new Uint8Array([1, 2, 3]).buffer;
    const down = new Uint8Array([4, 5]).buffer;

    server.deliver("hello");
    server.deliver(up);
    upstream.deliver("world");
    upstream.deliver(down);

    expect(upstream.sent).toEqual(["hello", up]);
    expect(upstream.sent[1]).toBe(up);
    expect(server.sent).toEqual(["world", down]);
    expect(server.sent[1]).toBe(down);
    expect(server.closes).toEqual([]);
    expect(upstream.closes).toEqual([]);
    upstream.readyState = 3;
    server.deliver("send to disconnected upstream");
    await settled(h);
    expect(server.closes).toEqual([{ code: 1011, reason: "session error" }]);
    expect(h.core.settleCalls).toHaveLength(1);
  });

  it("drops a message that arrives after the session has ended, without sending it", async () => {
    const h = harness();
    acceptUpgrade(h);
    await h.send(realtimeRequest());
    const { server } = pairOf();
    server.peerClose(1000, "bye");
    upstream.deliver("late");
    server.deliver("too late");
    expect(server.sent).toEqual([]);
    expect(upstream.sent).toEqual([]);
    await settled(h);
  });

  it("never writes the messages to the logs", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const h = harness();
    acceptUpgrade(h);
    await h.send(realtimeRequest());
    const { server } = pairOf();
    server.deliver("secret speech");
    server.peerClose(1000);
    await settled(h);
    expect(JSON.stringify([warn.mock.calls, log.mock.calls])).not.toContain("secret speech");
  });
});

describe("closing", () => {
  it("closes upstream with the close code of the customer and a fixed reason", async () => {
    const h = harness();
    acceptUpgrade(h);
    await h.send(realtimeRequest());
    pairOf().server.peerClose(4001, "done");
    expect(upstream.closes).toEqual([{ code: 4001, reason: "session closed" }]);
    await settled(h);
  });

  it("closes the customer with the close code of upstream and a fixed reason", async () => {
    const h = harness();
    acceptUpgrade(h);
    await h.send(realtimeRequest());
    const { server } = pairOf();
    upstream.peerClose(4002, "going away");
    expect(server.closes).toEqual([{ code: 4002, reason: "session closed" }]);
    await settled(h);
  });

  it.each([
    [0, 1011],
    [999, 1011],
    [1002, 1002],
    [1004, 1011],
    [1006, 1011],
    [1011, 1011],
    [1015, 1011],
    [5000, 1011],
    [65535, 1011],
    [1000, 1000],
    [1001, 1001],
    [1005, 1000],
    [3000, 3000],
    [4999, 4999],
  ])("sends close code %i as %i, a code the runtime accepts", async (received, sent) => {
    const h = harness();
    acceptUpgrade(h);
    await h.send(realtimeRequest());
    pairOf().server.peerClose(received);
    expect(upstream.closes).toEqual([{ code: sent, reason: "session closed" }]);
    await settled(h);
  });

  it("closes the other side with 1011 when the customer side fails", async () => {
    const h = harness();
    acceptUpgrade(h);
    await h.send(realtimeRequest());
    pairOf().server.fail();
    expect(upstream.closes).toEqual([{ code: 1011, reason: "session error" }]);
    await settled(h);
  });

  it("closes the other side with 1011 when upstream fails", async () => {
    const h = harness();
    acceptUpgrade(h);
    await h.send(realtimeRequest());
    const { server } = pairOf();
    upstream.fail();
    expect(server.closes).toEqual([{ code: 1011, reason: "session error" }]);
    await settled(h);
  });

  it("settles once when both sides close and fail", async () => {
    const h = harness();
    acceptUpgrade(h);
    await h.send(realtimeRequest());
    const { server } = pairOf();
    server.peerClose(1000, "bye");
    upstream.peerClose(1000, "bye");
    upstream.fail();
    server.fail();
    await settled(h);
    expect(h.core.settleCalls).toHaveLength(1);
    expect(upstream.closes).toEqual([{ code: 1000, reason: "session closed" }]);
    expect(server.closes).toEqual([]);
  });
});

describe("timers", () => {
  it("ends a session at the five minute limit with 1001 on both sides", async () => {
    vi.useFakeTimers();
    const h = harness();
    acceptUpgrade(h);
    await h.send(realtimeRequest());
    const { server } = pairOf();
    for (let minute = 0; minute < 9; minute += 1) {
      await vi.advanceTimersByTimeAsync(30_000);
      server.deliver("ping");
    }
    await vi.advanceTimersByTimeAsync(30_000);
    expect(server.closes).toEqual([{ code: 1000, reason: "session limit" }]);
    expect(upstream.closes).toEqual([{ code: 1000, reason: "session limit" }]);
    await settled(h);
  });

  it("ends an idle session after sixty seconds with 1001 on both sides", async () => {
    vi.useFakeTimers();
    const h = harness();
    acceptUpgrade(h);
    await h.send(realtimeRequest());
    const { server } = pairOf();
    await vi.advanceTimersByTimeAsync(AI_REALTIME_IDLE_MS - 1);
    expect(server.closes).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(server.closes).toEqual([{ code: 1001, reason: "session idle" }]);
    expect(upstream.closes).toEqual([{ code: 1001, reason: "session idle" }]);
    await settled(h);
  });

  it("restarts the idle timer on a message from either side", async () => {
    vi.useFakeTimers();
    const h = harness();
    acceptUpgrade(h);
    await h.send(realtimeRequest());
    const { server } = pairOf();
    await vi.advanceTimersByTimeAsync(50_000);
    upstream.deliver("reply");
    await vi.advanceTimersByTimeAsync(50_000);
    expect(server.closes).toEqual([]);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(server.closes).toEqual([{ code: 1001, reason: "session idle" }]);
    await settled(h);
  });
});

describe("settlement", () => {
  it("settles once with the cost orq recorded for the session trace", async () => {
    const h = harness();
    acceptUpgrade(h, null, 3.6e-6);
    await h.send(realtimeRequest());
    const traceId = sentTraceId(h);
    pairOf().server.peerClose(1000);
    await settled(h);
    expect(h.core.settleCalls).toEqual([
      {
        scope: scopeOf("any"),
        reservationId: "RES1",
        model: MODEL,
        costNanoUsd: 3_600n,
        usage: {},
        traceId,
      },
    ]);
    const telemetry = h.orq.calls.find((call) => call.url === TELEMETRY_URL);
    expect(JSON.parse(String(telemetry?.init.body))).toMatchObject({
      filters: [{ field: "trace_id", op: "eq", values: [traceId] }],
    });
  });

  it("starts the cost polling only after the session closed, and keeps polling until the late cost arrives", async () => {
    vi.useFakeTimers();
    const h = harness();
    let polls = 0;
    const queried: number[] = [];
    h.orq.respond((_init, url) => {
      if (url === TELEMETRY_URL) {
        queried.push(Date.now());
        polls += 1;
        // orq shows the cost a few seconds after the session ended: the fourth query is the first with a cost.
        return telemetryReply(polls >= 4 ? 0.0041464 : 0);
      }
      return upgradeAnswer(upstream, null);
    });
    await h.send(realtimeRequest());
    await vi.advanceTimersByTimeAsync(1_500);
    const closedAt = Date.now();
    pairOf().server.peerClose(1000);
    await vi.advanceTimersByTimeAsync(10_000);
    await settled(h);
    expect(queried).toHaveLength(4);
    expect(queried[0]).toBeGreaterThanOrEqual(closedAt);
    expect((queried.at(-1) ?? 0) - closedAt).toBeLessThanOrEqual(8_000);
    expect(h.core.settleCalls[0]).toMatchObject({ costNanoUsd: 4_146_400n });
  });

  it("settles an abrupt close with the cost recorded for the session trace", async () => {
    const h = harness();
    acceptUpgrade(h, null, 0.0041464);
    await h.send(realtimeRequest());
    const traceId = sentTraceId(h);
    pairOf().server.peerClose(1006);
    await settled(h);
    expect(upstream.closes).toEqual([{ code: 1011, reason: "session closed" }]);
    expect(h.core.settleCalls).toEqual([
      {
        scope: scopeOf("any"),
        reservationId: "RES1",
        model: MODEL,
        costNanoUsd: 4_146_400n,
        usage: {},
        traceId,
      },
    ]);
  });

  it("bills nothing for the elapsed time of an abrupt close when telemetry records no cost", async () => {
    vi.useFakeTimers();
    const h = harness();
    h.orq.respond((_init, url) => {
      if (url === TELEMETRY_URL) return Response.json({ data: [] });
      return upgradeAnswer(upstream, null);
    });
    await h.send(realtimeRequest());
    await vi.advanceTimersByTimeAsync(30_000);
    pairOf().server.peerClose(1006);
    await settled(h);
    expect(h.waits).toEqual([2_000, 2_000, 2_000, 2_000]);
    expect(h.core.settleCalls).toHaveLength(1);
    expect(h.core.settleCalls[0]).toMatchObject({ costNanoUsd: 0n, usage: {} });
  });

  it("charges a measured zero session as zero without a duration tariff", async () => {
    vi.useFakeTimers();
    const h = harness();
    acceptUpgrade(h, null, 0);
    await h.send(realtimeRequest());
    const traceId = sentTraceId(h);
    await vi.advanceTimersByTimeAsync(1_500);
    pairOf().server.peerClose(1000);
    await settled(h);
    expect(h.core.settleCalls[0]).toMatchObject({
      costNanoUsd: 0n,
      traceId,
    });
    expect(h.waits).toHaveLength(4);
  });

  it("settles an unmeasured session at zero without a minimum duration tariff", async () => {
    const h = harness();
    h.orq.respond((_init, url) =>
      url === TELEMETRY_URL ? Response.json({ data: [] }) : upgradeAnswer(upstream, null),
    );
    await h.send(realtimeRequest());
    const traceId = sentTraceId(h);
    pairOf().server.peerClose(1000);
    await settled(h);
    expect(h.core.settleCalls[0]).toMatchObject({
      costNanoUsd: 0n,
      traceId,
    });
    expect(h.waits).toHaveLength(4);
  });

  it("keeps the invocation alive until the session has settled", async () => {
    const h = harness();
    acceptUpgrade(h);
    await h.send(realtimeRequest());
    expect(h.ctx.pending).toHaveLength(1);
    pairOf().server.peerClose(1000);
    await settled(h);
    expect(h.core.settleCalls).toHaveLength(1);
  });

  it("settles through the retry path when the first settlement fails", async () => {
    const h = harness();
    h.core.settleFailures = 1;
    acceptUpgrade(h);
    await h.send(realtimeRequest());
    pairOf().server.peerClose(1000);
    await settled(h);
    expect(h.core.settleCalls).toHaveLength(2);
  });

  it("settles despite invalid peer close reasons, close exceptions and failed socket setup", async () => {
    const h = harness();
    acceptUpgrade(h);
    await h.send(realtimeRequest());
    const { server } = pairOf();
    server.closeFails = true;
    upstream.peerClose(1000, "\ufffd".repeat(123));
    await settled(h);
    expect(h.core.settleCalls).toHaveLength(1);
    expect(upstream.closes).toEqual([]);

    const failed = harness();
    upstream = new FakeSocket();
    upstream.acceptFails = true;
    acceptUpgrade(failed);
    expect((await failed.send(realtimeRequest())).status).toBe(502);
    await settled(failed);
    expect(failed.core.releases).toHaveLength(1);
  });

  it("does not charge elapsed session or polling time when telemetry is missing", async () => {
    vi.useFakeTimers();
    const h = harness();
    h.orq.respond((_init, url) => {
      if (url === TELEMETRY_URL) {
        vi.setSystemTime(Date.now() + 2_000);
        return Response.json({ data: [] });
      }
      return upgradeAnswer(upstream, "trace-missing");
    });
    await h.send(realtimeRequest());
    await vi.advanceTimersByTimeAsync(500);
    pairOf().server.peerClose(1000);
    await settled(h);
    expect(h.core.settleCalls[0]?.costNanoUsd).toBe(0n);
  });
});
