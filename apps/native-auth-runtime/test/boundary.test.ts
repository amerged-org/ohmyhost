import { describe, expect, it, vi } from "vitest";
import { createNativeAuthBoundary } from "../src/boundary.js";
import {
  createNativeLatencyProfile,
  endNativeLatency,
  nativeLatencyEnabled,
  nativeCapturedDurations,
  isNativeLatencyRequest,
  unwrapNativeLatencySession,
  startNativeLatency,
} from "../src/latency-profile.js";

const scope = {
  projectId: "project-a",
  environmentId: "dev",
  canonicalOrigin: "https://app.example",
  realmGeneration: 1,
  configurationRevision: 1,
};
const authority = {
  realm: scope,
  revocationEpoch: 1,
  enabled: true,
  sourceCapable: true,
  paidAllowed: true,
  runtimeAllowed: true,
};

describe("Native Auth private boundary", () => {
  it("accepts only the canonical origin and exact public methods while resolving current authority", async () => {
    const handle = vi.fn(async (request: Request) => new Response(request.method));
    const resolve = vi.fn(async () => authority);
    const boundary = createNativeAuthBoundary({ resolve, handle, validate: async () => null });
    expect(
      (
        await boundary.fetchPublic(
          new Request("https://app.example/api/auth/v1/admin/list-users"),
          scope,
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await boundary.fetchPublic(
          new Request("https://evil.example/api/auth/v1/get-session"),
          scope,
        )
      ).status,
    ).toBe(403);
    expect(handle).not.toHaveBeenCalled();
    const response = await boundary.fetchPublic(
      new Request("https://app.example/api/auth/v1/get-session", {
        headers: { "x-ohmyhost-project-id": "foreign" },
      }),
      scope,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(resolve).toHaveBeenCalledWith(scope);
    expect(handle.mock.calls[0]?.[0].headers.has("x-ohmyhost-project-id")).toBe(false);
  });

  it("denies disabled realms and never turns a failure into anonymous identity", async () => {
    const validate = vi.fn(async () => null);
    const boundary = createNativeAuthBoundary({
      resolve: async () => ({ ...authority, enabled: false }),
      handle: async () => new Response("unexpected"),
      validate,
    });
    expect(
      (
        await boundary.fetchPublic(
          new Request("https://app.example/api/auth/v1/get-session"),
          scope,
        )
      ).status,
    ).toBe(503);
    await expect(boundary.bind(scope).validateSession({ cookie: "session=value" })).rejects.toThrow(
      "auth_unavailable",
    );
    expect(validate).not.toHaveBeenCalled();
  });

  it("captures the trusted scope and allows a configuration-only revision without revoking sessions", async () => {
    const session = {
      user: { id: "u", email: "u@example.com" },
      session: { id: "s", expiresAt: "2027-01-01T00:00:00Z" },
    };
    const boundary = createNativeAuthBoundary({
      resolve: async () => ({ ...authority, realm: { ...scope, configurationRevision: 2 } }),
      handle: async () => new Response(),
      validate: async () => session,
    });
    expect(await boundary.bind(scope).validateSession({ cookie: "session=value" })).toEqual(
      session,
    );
    vi.useFakeTimers();
    try {
      const stalled = createNativeAuthBoundary({
        resolve: () => new Promise(() => {}),
        handle: async () => new Response(),
        validate: async () => null,
      });
      const response = stalled.fetchPublic(
        new Request("https://app.example/api/auth/v1/get-session"),
        scope,
      );
      await vi.advanceTimersByTimeAsync(15_000);
      expect((await response).status).toBe(503);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("private Native latency diagnostics", () => {
  it("admits only the explicit platform Dev flag and exact C5 realm", () => {
    const target = {
      projectId: "01M6PG6R7A0B8YJ9PBMZ9AB565",
      environmentId: "01M6PG6R7A0B8YJ9PBMZ9AB56A",
    };
    expect(nativeLatencyEnabled("c5-development-v1", target)).toBe(true);
    expect(nativeLatencyEnabled(undefined, target)).toBe(false);
    expect(nativeLatencyEnabled("production", target)).toBe(false);
    expect(nativeLatencyEnabled("c5-development-v1", { ...target, projectId: "other" })).toBe(
      false,
    );
    expect(nativeLatencyEnabled("c5-development-v1", { ...target, environmentId: "other" })).toBe(
      false,
    );
  });

  it("uses the default reporter for one redacted diagnostic", () => {
    const logger = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const profile = createNativeLatencyProfile({ clock: () => 1 });
      profile.finish("unavailable");
      expect(logger).toHaveBeenCalledTimes(1);
      const record = JSON.parse(String(logger.mock.calls[0]?.[0]));
      expect(record).toMatchObject({
        kind: "native_private_latency_v1",
        outcome: "unavailable",
        timingsAreNonAdditive: true,
      });
      expect(Object.keys(record).sort()).toEqual([
        "durations",
        "kind",
        "outcome",
        "timingsAreNonAdditive",
      ]);
      expect(Object.values(record.durations).every((value) => value === null || value === 0)).toBe(
        true,
      );
    } finally {
      logger.mockRestore();
    }
  });

  it("emits one bounded closed aggregate, retains honest long durations, and ignores diagnostic failures", () => {
    let clock = 10;
    const emit = vi.fn();
    const profile = createNativeLatencyProfile({ clock: () => clock, emit });
    const started = startNativeLatency(profile);
    clock = 20_012;
    endNativeLatency(profile, "engineMs", started);
    endNativeLatency(profile, "untrusted-secret-field" as never, started);
    profile.finish("active");
    profile.finish("absent");
    expect(emit).toHaveBeenCalledTimes(1);
    const record = JSON.parse(emit.mock.calls[0]?.[0] as string);
    expect(Object.keys(record).sort()).toEqual([
      "durations",
      "kind",
      "outcome",
      "timingsAreNonAdditive",
    ]);
    expect(record.kind).toBe("native_private_latency_v1");
    expect(record.outcome).toBe("active");
    expect(record.timingsAreNonAdditive).toBe(true);
    expect(record.durations.engineMs).toBe(20_002);
    expect(record.durations.totalMs).toBe(20_002);
    expect(Object.keys(record.durations)).toHaveLength(16);
    expect(record.durations).not.toHaveProperty("untrusted-secret-field");
    expect(
      Object.values(record.durations).every(
        (value) =>
          value === null || (typeof value === "number" && Number.isFinite(value) && value >= 0),
      ),
    ).toBe(true);
    const broken = createNativeLatencyProfile({
      clock: () => {
        throw Error("synthetic-sensitive");
      },
      emit: () => {
        throw Error("synthetic-sensitive");
      },
    });
    expect(() => {
      const mark = broken.start();
      broken.end("engineMs", mark);
      broken.finish("unavailable");
    }).not.toThrow();
    const hostile = {
      start: () => {
        throw Error("synthetic-sensitive");
      },
      end: () => {
        throw Error("synthetic-sensitive");
      },
    } as never;
    expect(startNativeLatency(hostile)).toBeNull();
    expect(() => endNativeLatency(hostile, "engineMs", null)).not.toThrow();
  });
});

it("decodes only closed private envelopes and drops broken telemetry without losing sessions", () => {
  const session = {
    user: { id: "u", email: "u@example.test" },
    session: { id: "s", expiresAt: "2030-01-01T00:00:00.000Z" },
  };
  let captured: unknown;
  const recorder = createNativeLatencyProfile({
    clock: () => 1,
    emit: (value) => {
      captured = JSON.parse(value);
    },
  });
  recorder.finish("active");
  const profile = nativeCapturedDurations(captured, "active");
  expect(profile).not.toBeNull();
  expect(nativeCapturedDurations(captured, "absent")).toBeNull();
  expect(isNativeLatencyRequest({ kind: "native_private_latency_request_v2" })).toBe(true);
  expect(isNativeLatencyRequest({ kind: "native_private_latency_request_v2", extra: true })).toBe(
    false,
  );
  const log = vi.fn();
  const envelope = { kind: "native_private_session_v2", status: "active", session, profile };
  expect(unwrapNativeLatencySession(envelope, log)).toEqual(session);
  expect(log).toHaveBeenCalledTimes(1);
  const event = JSON.parse(log.mock.calls[0]?.[0] as string);
  expect(event).toMatchObject({
    kind: "native_private_latency_v2",
    outcome: "active",
    timingsAreNonAdditive: true,
  });
  expect(JSON.stringify(event)).not.toContain("u@example.test");
  for (const clock of [
    () => Number.POSITIVE_INFINITY,
    () => -1,
    () => {
      throw new Error("clock");
    },
  ]) {
    const v3log = vi.fn();
    expect(unwrapNativeLatencySession(envelope, v3log, clock)).toEqual(session);
    expect(JSON.parse(v3log.mock.calls[0]?.[0] as string)).toMatchObject({
      kind: "native_private_latency_v3",
      outerServiceMs: null,
      timingsAreNonAdditive: true,
    });
  }
  expect(
    unwrapNativeLatencySession({ ...envelope, profile: { ...profile, secret: "private" } }, log),
  ).toEqual(session);
  expect(log).toHaveBeenCalledTimes(1);
  const brokenProfile = Object.defineProperty({ ...envelope }, "profile", {
    enumerable: true,
    get: () => {
      throw new Error("synthetic-profile-failure");
    },
  });
  expect(unwrapNativeLatencySession(brokenProfile, log)).toEqual(session);
  expect(log).toHaveBeenCalledTimes(1);
  expect(
    unwrapNativeLatencySession(envelope, () => {
      throw new Error("logger failure");
    }),
  ).toEqual(session);
  expect(
    unwrapNativeLatencySession(
      { ...envelope, status: "absent", session: null, profile: null },
      log,
    ),
  ).toBeNull();
  expect(() =>
    unwrapNativeLatencySession(
      { ...envelope, status: "unavailable", session: null, profile: null },
      log,
    ),
  ).toThrow("auth_unavailable");
  expect(() =>
    unwrapNativeLatencySession({ ...envelope, status: "active", session: null }, log),
  ).toThrow("auth_unavailable");
  expect(() =>
    unwrapNativeLatencySession({ ...envelope, session: { ...session, extra: "private" } }, log),
  ).toThrow("auth_unavailable");
  expect(() => unwrapNativeLatencySession({ ...envelope, extra: "private" }, log)).toThrow(
    "auth_unavailable",
  );
});
