import { afterEach, describe, expect, it, vi } from "vitest";
import {
  EU_CATALOG_BYTES,
  ENABLED_MODELS_BYTES,
  withOrqJson,
  METADATA_TIMEOUT_MS,
  MODEL_METADATA_BYTES,
  fetchEuModelIds,
  fetchModelLocations,
} from "../src/orq-metadata.js";
import { createAiGateway } from "../src/gateway.js";
import {
  FakeCore,
  FakeLimiter,
  FakeOrq,
  KEY,
  ORQ_BASE_URL,
  ORQ_KEY,
  answer,
  fakeContext,
  scopeOf,
} from "./fakes.js";

const CATALOG = "https://my.orq.ai/v2/model-catalog";
const MODEL = "provider/model?x=us&model=other#fragment";
const endpoint = (orq: FakeOrq) => ({ fetch: orq.fetch, baseUrl: ORQ_BASE_URL, apiKey: ORQ_KEY });
afterEach(() => vi.useRealTimers());

describe("authoritative orq jurisdiction metadata", () => {
  it("bounds concurrent metadata allocations in the request body's shared memory budget and releases capacity", async () => {
    const orq = new FakeOrq();
    const payload = new TextEncoder().encode(
      JSON.stringify({
        has_more: false,
        data: [{ id: "provider/opaque", location: ["eu"], description: "x".repeat(421_000) }],
      }),
    );
    const open: ReadableStreamDefaultController<Uint8Array>[] = [];
    orq.respond((_init, url) =>
      url.endsWith("/models")
        ? Response.json({ data: [{ id: "provider/opaque" }] })
        : new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(new Uint8Array(payload));
                open.push(controller);
              },
            }),
          ),
    );
    const pending = Array.from({ length: 64 }, () =>
      withOrqJson(endpoint(orq), `${ORQ_BASE_URL}/models`, ENABLED_MODELS_BYTES, async () =>
        fetchEuModelIds(endpoint(orq)),
      ).then(
        () => 200,
        () => 503,
      ),
    );
    try {
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(orq.calls.filter((call) => call.url.startsWith(CATALOG)).length).toBeLessThanOrEqual(
        4,
      );
    } finally {
      for (const controller of open) controller.close();
      const outcomes = await Promise.all(pending);
      expect(outcomes).toContain(503);
    }
    orq.respond(() =>
      Response.json({ has_more: false, data: [{ id: "provider/opaque", location: ["eu"] }] }),
    );
    expect([...(await fetchEuModelIds(endpoint(orq)))]).toEqual(["provider/opaque"]);
  });

  it("uses canonical per-segment model URLs without following redirects and applies exact upstream EU locations", async () => {
    for (const [id, location, status] of [
      ["mistral/mistral-small-latest", ["eu"], 200],
      ["anthropic/claude-haiku-5-5", ["global"], 403],
      ["mistral/voxtral-mini-transcribe-3", ["global", "eu", "us"], 403],
    ] as const) {
      const core = new FakeCore();
      core.scope = scopeOf("eu");
      const orq = new FakeOrq(),
        ctx = fakeContext();
      const canonical = `${CATALOG}/${id.split("/").map(encodeURIComponent).join("/")}`;
      orq.respond((_init, url) => {
        if (url === `${CATALOG}/${encodeURIComponent(id)}`)
          return new Response(null, { status: 307, headers: { location: canonical } });
        if (url === canonical) return Response.json({ model: { id, location } });
        if (url === `${ORQ_BASE_URL}/chat/completions`) return answer("{}", null);
        throw new Error("Unexpected upstream URL");
      });
      const gateway = createAiGateway({
        runtime: core,
        orq: endpoint(orq),
        limiter: new FakeLimiter(),
        authLimiter: new FakeLimiter(),
        newReservationId: () => "RES-canonical",
        wait: async () => undefined,
      });
      const result = await gateway.fetch(
        new Request("https://ai.test/v1/chat/completions", {
          method: "POST",
          headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
          body: JSON.stringify({ model: id, messages: [{ role: "user", content: "hello" }] }),
        }),
        ctx,
      );
      expect(result.status, id).toBe(status);
      expect(orq.calls[0]?.url).toBe(canonical);
      expect(orq.calls[0]?.init.redirect).toBe("manual");
      expect(core.admits).toHaveLength(status === 200 ? 1 : 0);
      await result.text();
      await ctx.drain();
    }
    const orq = new FakeOrq();
    orq.respond(() => Response.json({ model: { id: MODEL, location: ["eu"] } }));
    expect(await fetchModelLocations(endpoint(orq), MODEL)).toEqual(["eu"]);
    expect(orq.calls[0]?.url).toBe(
      `${CATALOG}/${MODEL.split("/").map(encodeURIComponent).join("/")}`,
    );
    const lookup = new URL(orq.calls[0]?.url ?? "");
    expect(lookup.origin).toBe("https://my.orq.ai");
    expect(lookup.search).toBe("");
    expect(lookup.hash).toBe("");
    expect(orq.calls[0]?.init.headers).toEqual({ authorization: `Bearer ${ORQ_KEY}` });
    expect(orq.calls[0]?.init.method).toBe("GET");
    expect(orq.calls[0]?.init.redirect).toBe("manual");
    orq.respond(() =>
      Response.json({
        has_more: false,
        data: [
          { id: "provider/opaque", location: ["eu"] },
          { id: "mistral/eu-name", location: ["global", "eu", "us"] },
          { id: "aws/eu.model", location: ["us"] },
          { id: "unknown/model", location: [] },
        ],
      }),
    );
    expect([...(await fetchEuModelIds(endpoint(orq)))]).toEqual(["provider/opaque"]);
    expect(orq.calls[1]?.url).toBe(`${CATALOG}?location=eu`);
  });

  it("fails closed on malformed, missing, mismatched, oversized and incomplete upstream metadata", async () => {
    const orq = new FakeOrq();
    for (const unsafe of [
      "",
      ".",
      "..",
      "/provider/model",
      "provider/model/",
      "provider//model",
      "provider/./model",
      "provider/../model",
      "provider/model/../../admin",
      "x".repeat(201),
      "\ud800",
    ]) {
      await expect(fetchModelLocations(endpoint(orq), unsafe)).rejects.toMatchObject({
        code: "ai_unavailable",
      });
    }
    expect(orq.calls).toEqual([]);
    const malformed = [
      null,
      {},
      { model: [] },
      { model: { id: MODEL } },
      { model: { id: MODEL, location: [7] } },
      { model: { id: "", location: ["eu"] } },
      { model: { id: "x".repeat(201), location: ["eu"] } },
      { model: { id: "other/model", location: ["eu"] } },
    ];
    for (const raw of malformed) {
      orq.respond(() => Response.json(raw));
      await expect(fetchModelLocations(endpoint(orq), MODEL)).rejects.toMatchObject({
        code: "ai_unavailable",
      });
    }
    for (const reply of [
      () => new Response("{", { status: 200 }),
      () => new Response(null, { status: 204 }),
      () => new Response("denied", { status: 401 }),
      () => new Response(null, { status: 302, headers: { location: "https://outside.example" } }),
      () => new Response("x".repeat(MODEL_METADATA_BYTES + 1)),
      () => Promise.reject(new TypeError("network error")),
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new Error("broken body"));
            },
          }),
        ),
    ]) {
      orq.respond(reply);
      await expect(fetchModelLocations(endpoint(orq), MODEL)).rejects.toMatchObject({
        code: "ai_unavailable",
      });
    }
    for (const raw of [
      null,
      {},
      { has_more: true, data: [] },
      { has_more: false, data: {} },
      { has_more: false, data: [{ id: "a/b" }] },
      {
        has_more: false,
        data: [
          { id: "a/b", location: ["eu"] },
          { id: "a/b", location: ["eu"] },
        ],
      },
    ]) {
      orq.respond(() => Response.json(raw));
      await expect(fetchEuModelIds(endpoint(orq))).rejects.toMatchObject({
        code: "ai_unavailable",
      });
    }
    orq.respond(() => new Response("x".repeat(EU_CATALOG_BYTES + 1)));
    await expect(fetchEuModelIds(endpoint(orq))).rejects.toMatchObject({ code: "ai_unavailable" });
    for (const item of ["0", "{}"]) {
      orq.respond(
        () => new Response('{"has_more":false,"data":[' + `${item},`.repeat(100_001) + item + "]}"),
      );
      await expect(fetchEuModelIds(endpoint(orq))).rejects.toMatchObject({
        code: "ai_unavailable",
      });
    }
  });

  it("bounds both stalled response headers and stalled body bytes with the same deadline", async () => {
    vi.useFakeTimers();
    const orq = new FakeOrq();
    for (const bodyStarted of [false, true]) {
      let signal: AbortSignal | null | undefined;
      let cancelled = false;
      orq.respond((init) => {
        signal = init.signal;
        return bodyStarted
          ? new Response(
              new ReadableStream<Uint8Array>({
                start(controller) {
                  controller.enqueue(new TextEncoder().encode('{"model":'));
                },
                cancel() {
                  cancelled = true;
                },
              }),
            )
          : new Promise<Response>(() => undefined);
      });
      const request = fetchModelLocations(endpoint(orq), MODEL);
      const failed = expect(request).rejects.toMatchObject({ code: "ai_unavailable" });
      await vi.advanceTimersByTimeAsync(METADATA_TIMEOUT_MS);
      await failed;
      expect(signal?.aborted).toBe(true);
      if (bodyStarted) expect(cancelled).toBe(true);
    }
  });
});
