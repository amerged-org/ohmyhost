import { describe, expect, it, vi } from "vitest";
import { executeMakeEndpoint, runMakeScenario } from "../src/providers/make-execution.js";

const context = { zone: "eu1", accessToken: "test-token", teamId: 7 };
const endpoint = {
  ...context,
  connectionId: 9,
  appName: "microsoft-email",
  appVersion: 2,
  endpointName: "listMessages",
  input: { top: 2 },
  idempotencyKey: "stable-key",
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const catalog = (privateEndpoint = false, connectionId = 9) => ({
  packages: [
    {
      name: "microsoft-email",
      versions: [
        {
          version: 2,
          endpoints: [
            {
              name: "listMessages",
              private: privateEndpoint,
              credentialsAvailable: [{ id: connectionId }],
            },
          ],
        },
      ],
    },
  ],
});

describe("Make execution", () => {
  it("checks the usable team endpoint and sends the fixed confidential wire request", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(json(catalog()))
      .mockResolvedValueOnce(json({ output: { value: [] } }));
    expect(await executeMakeEndpoint(endpoint, fetcher)).toEqual({
      ok: true,
      output: { output: { value: [] } },
    });
    expect(fetcher.mock.calls[0]?.[0]).toBe(
      "https://eu1.make.com/api/v2/imt/endpoints-usable?teamId=7",
    );
    const [url, options] = fetcher.mock.calls[1] ?? [];
    expect(url).toBe("https://eu1.make.com/api/v2/endpoints/execute");
    expect(JSON.parse(options?.body ?? "null")).toEqual({
      appName: "microsoft-email",
      appVersion: 2,
      endpointName: "listMessages",
      teamId: 7,
      connectionId: 9,
      input: { top: 2 },
      confidential: true,
      idempotencyKey: "stable-key",
    });
    expect(options.redirect).toBe("manual");
    for (const bad of [catalog(true), catalog(false, 10)]) {
      const unavailable = vi.fn().mockResolvedValueOnce(json(bad));
      expect(await executeMakeEndpoint(endpoint, unavailable)).toEqual({
        ok: false,
        kind: "denied",
      });
      expect(unavailable).toHaveBeenCalledTimes(1);
    }
    const blocked = vi.fn();
    expect(
      await executeMakeEndpoint({ ...endpoint, endpointName: "arbitraryCall" }, blocked),
    ).toEqual({ ok: false, kind: "denied" });
    expect(blocked).not.toHaveBeenCalled();
  });
  it("permits only the pinned, connection-bound three-module shell and safe inputs", async () => {
    const detail = {
      scenario: { id: 11, teamId: 7, isActive: true, scheduling: { type: "on-demand" } },
    };
    const flow = [
      { id: 2, module: "scenario-service:StartSubscenario", mapper: {}, parameters: {} },
      {
        id: 5,
        module: "microsoft-email:makeApiCall",
        parameters: { __IMTCONN__: 9 },
        mapper: {
          url: "{{2.path}}",
          method: "{{2.method}}",
          headers: "{{2.header}}",
          qs: "{{2.qs}}",
        },
      },
      {
        id: 4,
        module: "scenario-service:ReturnData",
        mapper: { data: "{{5.body}}" },
        parameters: {},
      },
    ];
    const iface = {
      interface: {
        input: [
          { name: "path", type: "text" },
          { name: "method", type: "text", required: true },
          { name: "header", type: "any" },
          { name: "qs", type: "any" },
        ],
        output: null,
      },
    };
    const req = {
      ...context,
      scenarioId: 11,
      connectionId: 9,
      method: "GET" as const,
      pathPrefix: "/v1.0/me/messages",
      inputs: {
        path: "/v1.0/me/messages/test%20file",
        method: "GET",
        header: [{ name: "Accept", value: "application/json" }],
        qs: [],
      },
    };
    const fake = (
      blueprint: unknown = { response: { blueprint: { flow } } },
      result: unknown = { executionId: "123", status: "1" },
    ) =>
      vi
        .fn()
        .mockResolvedValueOnce(json(detail))
        .mockResolvedValueOnce(json(blueprint))
        .mockResolvedValueOnce(json(iface))
        .mockResolvedValueOnce(json(result));
    const fetcher = fake();
    const methodOverride = vi.fn();
    expect(
      await runMakeScenario(
        {
          ...req,
          inputs: { ...req.inputs, header: [{ name: "X-HTTP-Method-Override", value: "DELETE" }] },
        },
        methodOverride,
      ),
    ).toEqual({ ok: false, kind: "denied" });
    expect(methodOverride).not.toHaveBeenCalled();
    expect(
      await runMakeScenario(
        { ...req, inputs: { ...req.inputs, header: { "X-HTTP-Method-Override": "DELETE" } } },
        methodOverride,
      ),
    ).toEqual({ ok: false, kind: "denied" });
    expect(methodOverride).not.toHaveBeenCalled();

    expect(await runMakeScenario(req, fetcher)).toEqual({
      ok: true,
      output: { executionId: "123", status: "1" },
    });
    expect(fetcher.mock.calls[1]?.[0]).toContain("/scenarios/11/blueprint");
    expect(JSON.parse(fetcher.mock.calls[3]?.[1]?.body ?? "null")).toEqual({
      data: req.inputs,
      responsive: true,
    });
    expect(
      await runMakeScenario(req, fake({ blueprint: { flow } }, { executionId: "123" })),
    ).toEqual({ ok: false, kind: "uncertain" });
    for (const path of [
      "https://evil.test/v1.0/me/messages",
      "//evil.test",
      "/v1.0/me/messages2",
      "/v1.0/me/messages/../other",
      "/v1.0/me/messages/%2e%2e",
      "/v1.0/me/messages%2fother",
      "/v1.0/me/messages?x=1",
      "/v1.0/me/messages#x",
      "/v1.0/me/messages\\other",
    ]) {
      const invalid = vi.fn();
      expect(
        await runMakeScenario({ ...req, inputs: { ...req.inputs, path } }, invalid),
        path,
      ).toEqual({ ok: false, kind: "denied" });
      expect(invalid).not.toHaveBeenCalled();
    }
    for (const header of [
      [{ name: "Authorization", value: "secret" }],
      [{ name: "Host", value: "evil" }],
      [{ name: "Cookie", value: "x" }],
    ]) {
      expect(await runMakeScenario({ ...req, inputs: { ...req.inputs, header } }, vi.fn())).toEqual(
        { ok: false, kind: "denied" },
      );
    }
    expect(
      await runMakeScenario({ ...req, inputs: { ...req.inputs, method: "POST" } }, vi.fn()),
    ).toEqual({ ok: false, kind: "denied" });
    for (const replacement of [
      { ...flow[1], module: "http:MakeRequest" },
      { ...flow[1], parameters: { __IMTCONN__: 10 } },
      { ...flow[1], mapper: { ...flow[1]?.mapper, url: "https://evil.test" } },
      { ...flow[1], mapper: { ...flow[1]?.mapper, extra: "{{2.body}}" } },
    ]) {
      const invalid = fake({ blueprint: { flow: [flow[0], replacement, flow[2]] } });
      expect(await runMakeScenario(req, invalid)).toEqual({ ok: false, kind: "denied" });
      expect(invalid).toHaveBeenCalledTimes(2);
    }
    expect(
      await runMakeScenario(
        req,
        fake({
          blueprint: { flow: [flow[0], flow[1], { ...flow[2], mapper: { data: "{{5}}" } }] },
        }),
      ),
    ).toEqual({ ok: false, kind: "denied" });
    const inactive = vi
      .fn()
      .mockResolvedValueOnce(json({ scenario: { ...detail.scenario, isActive: false } }));
    expect(await runMakeScenario(req, inactive)).toEqual({ ok: false, kind: "denied" });
  });
  it("classifies explicit rejections and uncertain dispatch without returning provider errors", async () => {
    const rejected = vi
      .fn()
      .mockResolvedValueOnce(json(catalog()))
      .mockResolvedValueOnce(json({ error: "secret" }, 403));
    expect(await executeMakeEndpoint(endpoint, rejected)).toEqual({ ok: false, kind: "denied" });
    const failed = vi
      .fn()
      .mockResolvedValueOnce(json(catalog()))
      .mockRejectedValueOnce(new Error("secret"));
    expect(await executeMakeEndpoint(endpoint, failed)).toEqual({ ok: false, kind: "uncertain" });
    const server = vi
      .fn()
      .mockResolvedValueOnce(json(catalog()))
      .mockResolvedValueOnce(json({ error: "secret" }, 500));
    expect(await executeMakeEndpoint(endpoint, server)).toEqual({ ok: false, kind: "uncertain" });
  });
});
