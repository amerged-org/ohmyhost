import { describe, expect, it, vi } from "vitest";

import {
  WorkosSessionStatusUnavailableError,
  createWorkosSessionStatusClient,
} from "../src/workos-session-status.js";

const request = {
  sessionId: "session_1",
  userId: "user_1",
  organizationId: "org_1",
  tokenExpiresAt: 1_776_505_500,
};

describe("private WorkOS session-status client", () => {
  it.each([true, false])("accepts the exact active=%s response without caching", async (active) => {
    const fetch = vi.fn().mockImplementation(
      async () =>
        new Response(JSON.stringify({ active }), {
          status: 200,
          headers: { "content-type": "application/json", "cache-control": "no-store" },
        }),
    );
    const client = createWorkosSessionStatusClient({ fetch });

    await expect(client.isActive(request)).resolves.toBe(active);
    await expect(client.isActive(request)).resolves.toBe(active);

    expect(fetch).toHaveBeenCalledTimes(2);
    const sent = fetch.mock.calls[0]?.[0] as Request;
    expect(sent.url).toBe("https://auth-status.internal/session-status");
    expect(sent.method).toBe("POST");
    expect(sent.headers.get("authorization")).toBeNull();
    expect(sent.headers.get("content-type")).toBe("application/json");
    expect(sent.headers.get("accept")).toBe("application/json");
    await expect(sent.json()).resolves.toEqual(request);
  });

  it.each([
    [
      "private 503",
      new Response('{"active":false}', {
        status: 503,
        headers: { "content-type": "application/json", "cache-control": "no-store" },
      }),
    ],
    [
      "malformed",
      new Response("not-json", {
        status: 200,
        headers: { "content-type": "application/json", "cache-control": "no-store" },
      }),
    ],
    [
      "extra field",
      Response.json(
        { active: true, detail: "provider-secret" },
        { headers: { "cache-control": "no-store" } },
      ),
    ],
    [
      "oversized",
      new Response("{}", {
        headers: {
          "content-type": "application/json",
          "cache-control": "no-store",
          "content-length": "2049",
        },
      }),
    ],
    ["unexpected status", new Response(null, { status: 418 })],
  ])("maps %s to one redacted unavailable error", async (_name, response) => {
    const client = createWorkosSessionStatusClient({ fetch: vi.fn().mockResolvedValue(response) });

    await expect(client.isActive(request)).rejects.toEqual(
      new WorkosSessionStatusUnavailableError(),
    );
  });

  it("rejects a non-contract request before invoking the private binding", async () => {
    const fetch = vi.fn();
    const client = createWorkosSessionStatusClient({ fetch });

    await expect(
      client.isActive({ ...request, detail: "provider-secret" } as typeof request),
    ).rejects.toEqual(new WorkosSessionStatusUnavailableError());
    expect(fetch).not.toHaveBeenCalled();
  });

  it("fails after five seconds even when the private binding ignores cancellation", async () => {
    vi.useFakeTimers();
    try {
      let sentRequest: Request | undefined;
      const client = createWorkosSessionStatusClient({
        fetch: vi.fn((sent: Request) => {
          sentRequest = sent;
          return new Promise<Response>(() => undefined);
        }),
      });
      const result = expect(client.isActive(request)).rejects.toEqual(
        new WorkosSessionStatusUnavailableError(),
      );

      await vi.advanceTimersByTimeAsync(5_000);

      await result;
      expect(sentRequest?.signal.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
