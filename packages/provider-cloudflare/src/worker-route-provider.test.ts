import { describe, expect, it, vi } from "vitest";

import {
  CloudflareWorkerRouteConflictError,
  CloudflareWorkerRouteContractError,
  CloudflareWorkerRouteReceiptMismatchError,
  CloudflareWorkerRouteRejectedError,
  CloudflareWorkerRouteUncertainError,
  createCloudflareWorkerRouteProvider,
  type CloudflareWorkerRouteReceipt,
  type CloudflareWorkerRouteTarget,
} from "./worker-route-provider.js";

const ZONE_ID = "b818216abd5a7b9517036f566b1f0879";
const ROUTE_ID = "1234567890abcdef1234567890abcdef";
const target = {
  hostname: "app.poc.aixyte.com",
  scriptName: "calm-otter-builds",
} as const satisfies CloudflareWorkerRouteTarget;
const route = {
  id: ROUTE_ID,
  pattern: `${target.hostname}/*`,
  script: target.scriptName,
};

function envelope(result: unknown, status = 200) {
  return Response.json(
    {
      success: status < 400,
      errors: status === 404 ? [{ code: 10090, message: "not found" }] : [],
      messages: [],
      result,
    },
    { status },
  );
}

function provider(fetch: typeof globalThis.fetch) {
  return createCloudflareWorkerRouteProvider({
    zoneId: ZONE_ID,
    apiToken: "token-" + "x".repeat(32),
    fetch,
    now: () => new Date("2026-08-29T10:00:00.000Z"),
  });
}

describe("Cloudflare Worker route provider", () => {
  it("requires one exact platform wildcard route without creating a project route", async () => {
    const platform = {
      pattern: "*.dev.check.omh.st/*" as const,
      scriptName: "ohmyho-gateway-poc-private-fullstack" as const,
    };
    const observed = { id: ROUTE_ID, pattern: platform.pattern, script: platform.scriptName };
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(envelope([observed]));
    await expect(provider(fetch).observePlatformWildcardRoute(platform)).resolves.toMatchObject({
      routeId: ROUTE_ID,
      pattern: platform.pattern,
      scriptName: platform.scriptName,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]?.[1]?.method).toBe("GET");
    await expect(
      provider(async () =>
        envelope([{ ...observed, script: "foreign-worker" }]),
      ).observePlatformWildcardRoute(platform),
    ).rejects.toBeInstanceOf(CloudflareWorkerRouteConflictError);
  });

  it("replaces only the exact reviewed wildcard route ID and reads back its new script", async () => {
    const input = {
      routeId: ROUTE_ID,
      pattern: "*.dev.check.omh.st/*" as const,
      expectedScript: "ohmyho-public-production",
      scriptName: "ohmyho-gateway-poc-private-fullstack",
    };
    const old = { id: ROUTE_ID, pattern: input.pattern, script: input.expectedScript };
    const updated = { ...old, script: input.scriptName };
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(envelope(old))
      .mockResolvedValueOnce(envelope(updated))
      .mockResolvedValueOnce(envelope(updated));
    await expect(provider(fetch).replacePlatformWildcardRoute(input)).resolves.toMatchObject({
      outcome: "updated",
      receipt: { routeId: ROUTE_ID, pattern: input.pattern, scriptName: input.scriptName },
    });
    expect(fetch.mock.calls.map(([, options]) => options?.method)).toEqual(["GET", "PUT", "GET"]);
    expect(fetch.mock.calls[1]?.[0]).toContain(`/workers/routes/${ROUTE_ID}`);
    expect(JSON.parse(String(fetch.mock.calls[1]?.[1]?.body))).toEqual({
      pattern: input.pattern,
      script: input.scriptName,
    });

    const replay = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(envelope(updated));
    await expect(provider(replay).replacePlatformWildcardRoute(input)).resolves.toMatchObject({
      outcome: "existing",
    });
    expect(replay).toHaveBeenCalledTimes(1);
    await expect(
      provider(async () =>
        envelope({ ...old, script: "foreign-worker" }),
      ).replacePlatformWildcardRoute(input),
    ).rejects.toBeInstanceOf(CloudflareWorkerRouteConflictError);
    const recovered = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(envelope(old))
      .mockRejectedValueOnce(new Error("network unavailable"))
      .mockResolvedValueOnce(envelope(updated));
    await expect(provider(recovered).replacePlatformWildcardRoute(input)).resolves.toMatchObject({
      outcome: "recovered",
    });
    const invalid = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(envelope(old))
      .mockResolvedValueOnce(envelope({ ...updated, id: "f".repeat(32) }))
      .mockResolvedValueOnce(envelope(updated));
    await expect(provider(invalid).replacePlatformWildcardRoute(input)).resolves.toMatchObject({
      outcome: "recovered",
    });
    const stillOld = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(envelope(old))
      .mockResolvedValueOnce(envelope({ ...updated, id: "f".repeat(32) }))
      .mockResolvedValueOnce(envelope(old));
    await expect(provider(stillOld).replacePlatformWildcardRoute(input)).rejects.toBeInstanceOf(
      CloudflareWorkerRouteContractError,
    );

    const forcedRestore = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(envelope(old))
      .mockResolvedValueOnce(envelope(old))
      .mockResolvedValueOnce(envelope(old));
    await expect(
      provider(forcedRestore).replacePlatformWildcardRoute({
        ...input,
        expectedScript: input.scriptName,
        scriptName: input.expectedScript,
        forceWrite: true,
      }),
    ).resolves.toMatchObject({ outcome: "updated", receipt: { scriptName: input.expectedScript } });
    expect(forcedRestore.mock.calls.map(([, options]) => options?.method)).toEqual([
      "GET",
      "PUT",
      "GET",
    ]);
  });
  it("moves one receipt-bound Paid route ID to a new script in place and reads it back", async () => {
    const receipt = {
      routeId: ROUTE_ID,
      hostname: "amerged.example",
      pattern: "amerged.example/*",
      scriptName: "g-p-01arz3ndektsv4rrffq69g5fav-prod",
      observedAt: new Date("2026-08-29T09:00:00.000Z"),
    } satisfies CloudflareWorkerRouteReceipt;
    const shared = "ohmyho-gateway-production";
    const old = { id: ROUTE_ID, pattern: receipt.pattern, script: receipt.scriptName };
    const moved = { ...old, script: shared };
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(envelope(old))
      .mockResolvedValueOnce(envelope(moved))
      .mockResolvedValueOnce(envelope(moved));
    await expect(provider(fetch).retargetRoute(receipt, shared)).resolves.toMatchObject({
      outcome: "updated",
      receipt: {
        routeId: ROUTE_ID,
        hostname: receipt.hostname,
        pattern: receipt.pattern,
        scriptName: shared,
      },
    });
    expect(fetch.mock.calls.map(([, options]) => options?.method)).toEqual(["GET", "PUT", "GET"]);
    expect(fetch.mock.calls[1]?.[0]).toContain(`/workers/routes/${ROUTE_ID}`);
    expect(JSON.parse(String(fetch.mock.calls[1]?.[1]?.body))).toEqual({
      pattern: receipt.pattern,
      script: shared,
    });
    // A replay after a lost receipt write only reads back the already moved route.
    const replay = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(envelope(moved));
    await expect(provider(replay).retargetRoute(receipt, shared)).resolves.toMatchObject({
      outcome: "existing",
    });
    expect(replay).toHaveBeenCalledTimes(1);
    // Another host's or another script's route is never rewritten.
    for (const drifted of [
      { ...old, script: "foreign-worker" },
      { ...old, pattern: "other.example/*" },
    ]) {
      const refused = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(envelope(drifted));
      await expect(provider(refused).retargetRoute(receipt, shared)).rejects.toBeInstanceOf(
        drifted.pattern === receipt.pattern
          ? CloudflareWorkerRouteConflictError
          : CloudflareWorkerRouteReceiptMismatchError,
      );
      expect(refused).toHaveBeenCalledTimes(1);
    }
    const unconfirmed = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(envelope(old))
      .mockRejectedValueOnce(new Error("network unavailable"))
      .mockResolvedValueOnce(envelope(old));
    await expect(provider(unconfirmed).retargetRoute(receipt, shared)).rejects.toBeInstanceOf(
      CloudflareWorkerRouteUncertainError,
    );
  });

  it("observes one exact host route to the exact gateway script", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        envelope([{ id: "f".repeat(32), pattern: "other.example.com/*", script: null }, route]),
      );

    await expect(provider(fetch).observeRoute(target)).resolves.toEqual({
      state: "found",
      routeId: ROUTE_ID,
      ...target,
      pattern: `${target.hostname}/*`,
      observedAt: new Date("2026-08-29T10:00:00.000Z"),
    });
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({ method: "GET", redirect: "manual" });
    const wallStart = Date.now();
    const observed = await createCloudflareWorkerRouteProvider({
      zoneId: ZONE_ID,
      apiToken: "token-" + "x".repeat(32),
      fetch: async () => envelope([route]),
    }).observeRoute(target);
    expect(observed.state).toBe("found");
    if (observed.state !== "found") throw new Error("Expected exact route observation");
    expect(observed.observedAt.getTime()).toBeGreaterThanOrEqual(wallStart);
    expect(observed.observedAt.getTime()).toBeLessThanOrEqual(Date.now());
    expect(observed.routeId).toBe(ROUTE_ID);
  });

  it("treats script:null and a foreign script on the exact host as conflicts", async () => {
    for (const script of [null, "attacker-script"]) {
      const fetch = vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValueOnce(envelope([{ ...route, script }]));
      await expect(provider(fetch).observeRoute(target)).rejects.toBeInstanceOf(
        CloudflareWorkerRouteConflictError,
      );
    }
  });

  it("creates one exact route, confirms it, and replays an existing route", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(envelope([]))
      .mockResolvedValueOnce(envelope(route))
      .mockResolvedValueOnce(envelope([route]));
    await expect(provider(fetch).createRoute(target)).resolves.toMatchObject({
      outcome: "created",
      receipt: { routeId: ROUTE_ID, pattern: `${target.hostname}/*` },
    });
    expect(JSON.parse(String(fetch.mock.calls[1]?.[1]?.body))).toEqual({
      pattern: `${target.hostname}/*`,
      script: target.scriptName,
    });

    const replay = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(envelope([route]));
    await expect(provider(replay).createRoute(target)).resolves.toMatchObject({
      outcome: "existing",
    });
    expect(replay).toHaveBeenCalledOnce();
  });

  it("recovers a lost create response only through exact route readback", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(envelope([]))
      .mockRejectedValueOnce(new Error("lost response"))
      .mockResolvedValueOnce(envelope([route]));
    await expect(provider(fetch).createRoute(target)).resolves.toMatchObject({
      outcome: "recovered",
      receipt: { routeId: ROUTE_ID },
    });
    expect(fetch.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);

    const conflictFetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(envelope([]))
      .mockResolvedValueOnce(envelope(null, 409))
      .mockResolvedValueOnce(envelope([route]));
    await expect(provider(conflictFetch).createRoute(target)).resolves.toMatchObject({
      outcome: "recovered",
      receipt: { routeId: ROUTE_ID },
    });

    const unresolvedConflict = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(envelope([]))
      .mockResolvedValueOnce(envelope(null, 409))
      .mockResolvedValueOnce(envelope([]));
    await expect(provider(unresolvedConflict).createRoute(target)).rejects.toBeInstanceOf(
      CloudflareWorkerRouteRejectedError,
    );
    expect(
      unresolvedConflict.mock.calls.filter(([, init]) => init?.method === "POST"),
    ).toHaveLength(1);
  });

  it("deletes the receipt-bound route ID and requires exact GET-404 absence", async () => {
    const receipt = receiptValue();
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(envelope(route))
      .mockResolvedValueOnce(envelope({ id: ROUTE_ID }))
      .mockResolvedValueOnce(envelope(null, 404));
    await expect(provider(fetch).deleteRoute(receipt)).resolves.toEqual({
      outcome: "deleted",
      routeId: ROUTE_ID,
      pattern: `${target.hostname}/*`,
      observedAt: new Date("2026-08-29T10:00:00.000Z"),
    });
    expect(String(fetch.mock.calls[1]?.[0]).endsWith(`/workers/routes/${ROUTE_ID}`)).toBe(true);

    const replay = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(envelope(null, 404));
    await expect(provider(replay).deleteRoute(receipt)).resolves.toMatchObject({
      outcome: "absent",
    });
  });

  it("recovers lost delete, but rejects drift and an unconfirmed result", async () => {
    const receipt = receiptValue();
    const recovered = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(envelope(route))
      .mockRejectedValueOnce(new Error("lost"))
      .mockResolvedValueOnce(envelope(null, 404));
    await expect(provider(recovered).deleteRoute(receipt)).resolves.toMatchObject({
      outcome: "deleted",
    });

    const drifted = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(envelope({ ...route, script: "attacker-script" }));
    await expect(provider(drifted).deleteRoute(receipt)).rejects.toBeInstanceOf(
      CloudflareWorkerRouteReceiptMismatchError,
    );

    const uncertain = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(envelope(route))
      .mockResolvedValueOnce(new Response("malformed", { status: 200 }))
      .mockResolvedValueOnce(envelope(route));
    await expect(provider(uncertain).deleteRoute(receipt)).rejects.toBeInstanceOf(
      CloudflareWorkerRouteUncertainError,
    );
  });

  it("rejects invalid provider and target input before transport", async () => {
    expect(() =>
      createCloudflareWorkerRouteProvider({
        zoneId: "invalid",
        apiToken: "short",
        fetch: globalThis.fetch,
      }),
    ).toThrow("Cloudflare Worker route input is invalid");
    await expect(
      provider(vi.fn()).observeRoute({ ...target, hostname: "https://attacker.test" }),
    ).rejects.toThrow("Cloudflare Worker route input is invalid");
  });

  it("returns a definitive typed rejection for a denied create", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(envelope([]))
      .mockResolvedValueOnce(envelope(null, 403));
    await expect(provider(fetch).createRoute(target)).rejects.toBeInstanceOf(
      CloudflareWorkerRouteRejectedError,
    );
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("classifies observe denial separately from transport and server uncertainty", async () => {
    await expect(
      provider(
        vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(envelope([], 403)),
      ).observeRoute(target),
    ).rejects.toBeInstanceOf(CloudflareWorkerRouteRejectedError);
    for (const fetch of [
      vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(envelope([], 503)),
      vi.fn<typeof globalThis.fetch>().mockRejectedValueOnce(new Error("transport")),
    ]) {
      await expect(provider(fetch).observeRoute(target)).rejects.toBeInstanceOf(
        CloudflareWorkerRouteUncertainError,
      );
    }
  });
});

function receiptValue(): CloudflareWorkerRouteReceipt {
  return Object.freeze({
    routeId: ROUTE_ID,
    ...target,
    pattern: `${target.hostname}/*`,
    observedAt: new Date("2026-08-29T09:00:00.000Z"),
  });
}
