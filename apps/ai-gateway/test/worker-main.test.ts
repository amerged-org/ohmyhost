import { afterEach, describe, expect, it, vi } from "vitest";
import worker, { gatewayFromEnvironment } from "../src/worker-main.js";
import {
  answer,
  bodyOf,
  FakeCore,
  FakeLimiter,
  fakeContext,
  HAIKU,
  KEY,
  ORQ_BASE_URL,
  scopeOf,
} from "./fakes.js";

const ORQ_ENV = {
  ORQ_API_KEY: "orq-test-key",
  ORQ_BASE_URL,
  ORQ_ORIGIN: "https://my.orq.ai",
};

function environment(overrides: Record<string, unknown> = {}) {
  return {
    AI_RUNTIME: new FakeCore(),
    PROJECT_LIMITER: new FakeLimiter(),
    AUTH_LIMITER: new FakeLimiter(),
    ...ORQ_ENV,
    ...overrides,
  };
}

function models(): Request {
  return new Request("https://ai.test/v1/models", { headers: { authorization: `Bearer ${KEY}` } });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("environment", () => {
  it("builds the gateway when every binding, the secret and the orq address are present", () => {
    expect(gatewayFromEnvironment(environment())).not.toBeNull();
  });

  it.each([
    ["the Core binding", { AI_RUNTIME: undefined }],
    ["a Core binding without the release method", { AI_RUNTIME: { authorizeKey: () => null } }],
    ["the limiter", { PROJECT_LIMITER: undefined }],
    ["a limiter without limit", { PROJECT_LIMITER: {} }],
    ["the address limiter", { AUTH_LIMITER: undefined }],
    ["an address limiter without limit", { AUTH_LIMITER: {} }],
    ["the orq secret", { ORQ_API_KEY: undefined }],
    ["an empty orq secret", { ORQ_API_KEY: "" }],
    ["the orq base URL", { ORQ_BASE_URL: undefined }],
    ["an orq base URL that is not a URL", { ORQ_BASE_URL: "not a url" }],
    ["an orq origin that differs from the base URL", { ORQ_ORIGIN: "https://evil.example" }],
    ["an orq origin that is missing", { ORQ_ORIGIN: undefined }],
  ])("returns no gateway without %s", (_label, overrides) => {
    expect(gatewayFromEnvironment(environment(overrides))).toBeNull();
  });

  it("returns no gateway for an environment that is not an object", () => {
    expect(gatewayFromEnvironment(undefined)).toBeNull();
  });
});

describe("fetch", () => {
  it("answers 503 ai_unavailable with the security headers when the environment is incomplete", async () => {
    const response = await worker.fetch(
      models(),
      environment({ ORQ_API_KEY: undefined }),
      fakeContext(),
    );
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      error: {
        message: "The AI gateway is unavailable right now.",
        type: "server_error",
        code: "ai_unavailable",
      },
    });
  });

  it("serves the model list of orq, filtered to the scope jurisdiction", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      calls.push(url);
      if (url === "https://my.orq.ai/v2/model-catalog?location=eu")
        return Response.json({
          data: [{ id: "mistral/mistral-large", location: ["eu"] }],
          has_more: false,
        });
      return Response.json({
        data: [{ id: HAIKU }, { id: "openai/gpt-4o" }, { id: "mistral/mistral-large" }],
      });
    });
    const core = new FakeCore();
    core.scope = scopeOf("eu");
    const response = await worker.fetch(models(), environment({ AI_RUNTIME: core }), fakeContext());
    expect(response.status).toBe(200);
    const body = (await response.json()) as { data: { id: string }[] };
    expect(body.data.map((model) => model.id)).toEqual(["mistral/mistral-large"]);
    expect(calls).toEqual([
      `${ORQ_BASE_URL}/models`,
      "https://my.orq.ai/v2/model-catalog?location=eu",
    ]);
  });

  it("forwards a chat call to orq with the configured key and the Worker's global fetch", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return answer(JSON.stringify({ id: "chat-1" }), "trace-w");
    });
    const core = new FakeCore();
    const ctx = fakeContext();
    const request = new Request("https://ai.test/v1/chat/completions", {
      method: "POST",
      headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ model: HAIKU, messages: [{ role: "user", content: "Hi" }] }),
    });
    const response = await worker.fetch(request, environment({ AI_RUNTIME: core }), ctx);
    expect(response.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`${ORQ_BASE_URL}/chat/completions`);
    expect(calls[0]?.init.headers).toEqual({
      authorization: "Bearer orq-test-key",
      "content-type": "application/json",
      "x-orq-identity-id": expect.any(String),
    });
    expect(bodyOf(calls[0]?.init)).toEqual({
      model: HAIKU,
      messages: [{ role: "user", content: "Hi" }],
    });
    expect(core.admits[0]?.reservationId).toMatch(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/u);
    await response.text();
    await ctx.drain();
    expect(core.settleCalls).toHaveLength(1);
  });
});

describe("trace cost fallback", () => {
  it("queries the trace cost up to five times, 2000 ms apart, when the answer has no usage", async () => {
    vi.useFakeTimers();
    const urls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      urls.push(url);
      if (url.endsWith("/v3/telemetry/query")) return Response.json({ data: [] });
      return new Response("{}", { status: 200, headers: { "x-orq-trace-id": "trace-w" } });
    });
    const core = new FakeCore();
    const ctx = fakeContext();
    const request = new Request("https://ai.test/v1/chat/completions", {
      method: "POST",
      headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ model: HAIKU, messages: [{ role: "user", content: "Hi" }] }),
    });
    const response = await worker.fetch(request, environment({ AI_RUNTIME: core }), ctx);
    expect(response.status).toBe(200);
    await response.text();
    const settled = ctx.drain();
    await vi.advanceTimersByTimeAsync(8_000);
    await settled;
    expect(urls.filter((url) => url.endsWith("/v3/telemetry/query"))).toHaveLength(5);
    expect(core.settleCalls).toHaveLength(1);
    expect(core.settleCalls[0]?.traceId).toBe("trace-w");
  });
});

describe("scheduled", () => {
  it("runs the reservation sweep of the configured Core", async () => {
    const core = new FakeCore();
    core.sweepReleased = 0;
    await worker.scheduled({ cron: "*/10 * * * *" }, environment({ AI_RUNTIME: core }));
    expect(core.sweeps).toEqual([{ olderThanMs: 900_000, limit: 200 }]);
  });

  it("logs a closed token and rethrows when the environment is incomplete", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await expect(
      worker.scheduled({ cron: "*/10 * * * *" }, environment({ ORQ_API_KEY: undefined })),
    ).rejects.toThrow("ai_gateway_unconfigured");
    expect(warn).toHaveBeenCalledWith(
      JSON.stringify({ event: "ai_gateway_sweep", outcome: "sweep_failed" }),
    );
  });
});
