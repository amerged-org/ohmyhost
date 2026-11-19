import { describe, expect, it } from "vitest";

import { routePreviewRequest } from "../src/preview-routing.js";

describe("preview ingress", () => {
  it("forwards only canonical capability hosts and removes untrusted platform headers", async () => {
    const requests: Request[] = [];
    const binding = {
      fetch: async (request: Request) => {
        requests.push(request);
        return new Response("preview");
      },
    };
    const token = `${"a".repeat(51)}q`;
    const url = `https://${token}.preview.dev.omh.st/path?q=1`;
    const result = await routePreviewRequest(
      new Request(url, {
        headers: {
          origin: `https://${token}.preview.dev.omh.st`,
          "x-ohmyhost-project": "spoof",
          "cf-connecting-ip": "203.0.113.5",
          "x-ohmyhost-preview-client-address": "198.51.100.1",
          "x-forwarded-host": "spoof",
        },
      }),
      { PREVIEW_HOST_SUFFIX: "preview.dev.omh.st", PREVIEW_RUNTIME: binding },
    );
    expect(await result?.text()).toBe("preview");
    expect(requests[0]?.url).toBe(url);
    expect(requests[0]?.headers.get("origin")).toBe(`https://${token}.preview.dev.omh.st`);
    expect(requests[0]?.headers.get("x-ohmyhost-preview-client-address")).toBe("203.0.113.5");
    for (const header of ["x-ohmyhost-project", "cf-connecting-ip", "x-forwarded-host"])
      expect(requests[0]?.headers.has(header)).toBe(false);
    expect(
      (
        await routePreviewRequest(new Request("https://short.preview.dev.omh.st/"), {
          PREVIEW_HOST_SUFFIX: "preview.dev.omh.st",
          PREVIEW_RUNTIME: binding,
        })
      )?.status,
    ).toBe(404);
    expect(
      await routePreviewRequest(new Request("https://example.com/"), {
        PREVIEW_HOST_SUFFIX: "preview.dev.omh.st",
        PREVIEW_RUNTIME: binding,
      }),
    ).toBeNull();
  });

  it("passes mutations to the policy-aware runtime and rejects foreign WebSocket origins", async () => {
    let calls = 0;
    const environment = {
      PREVIEW_HOST_SUFFIX: "preview.dev.omh.st",
      PREVIEW_RUNTIME: {
        fetch: async () => {
          calls++;
          return new Response();
        },
      },
    };
    const url = `https://${"a".repeat(52)}.preview.dev.omh.st/`;
    expect(
      (
        await routePreviewRequest(
          new Request(url, { method: "POST", headers: { origin: "https://allowed.example" } }),
          environment,
        )
      )?.status,
    ).toBe(200);
    for (const init of [
      { headers: { origin: "https://attacker.example", upgrade: "websocket" } },
      { headers: { upgrade: "websocket" } },
    ]) {
      expect((await routePreviewRequest(new Request(url, init), environment))?.status).toBe(403);
    }
    expect(calls).toBe(1);
  });
});
