import { beforeEach, describe, expect, it, vi } from "vitest";

const workerState = vi.hoisted(() => ({ env: undefined as unknown }));

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    readonly adapter = true;
  },
  WorkerEntrypoint: class {
    public readonly env = workerState.env;
  },
}));

describe("private DevAccessService binding", () => {
  beforeEach(() => {
    workerState.env = {
      CONTROL_API_RATE_LIMITER: { limit: vi.fn().mockResolvedValue({ success: true }) },
      PUBLIC_ENTRY_RATE_LIMITER: { limit: vi.fn().mockResolvedValue({ success: true }) },
      DEV_ACCESS_SESSION_PRIVATE_JWK: "{}",
      DEV_ACCESS_SESSION_PUBLIC_JWK: "{}",
    };
  });

  it("exports only private dev-access RPC methods and redacts malformed credentials", async () => {
    const { DevAccessService } = await import("../src/worker-main.js");
    const service = new DevAccessService({} as never, workerState.env as never);
    expect(typeof service.redeem).toBe("function");
    expect(typeof service.authorize).toBe("function");
    expect(typeof service.issueRuntimeProbe).toBe("function");
    expect("fetch" in service).toBe(false);
    await expect(
      service.redeem({
        ticket: "sensitive-ticket",
        projectId: "invalid" as never,
        environmentId: "invalid" as never,
        handle: "invalid",
        origin: "https://attacker.example",
        clientAddress: "198.51.100.7",
      }),
    ).rejects.toThrow("Dev access redemption is unavailable");
  });

  it("exposes runtime admission only as scoped private RPC and rejects untrusted or throttled inputs", async () => {
    const { RuntimeCreditService } = await import("../src/worker-main.js");
    const scope = {
      includePaidPlan: true,
      organizationId: "01H00000000000000000000801",
      projectId: "01H00000000000000000000802",
      environmentId: "01H00000000000000000000803",
    };
    workerState.env = {
      CONTROL_API_RATE_LIMITER: { limit: async () => ({ success: false }) },
    };
    const service = new RuntimeCreditService({} as never, workerState.env as never);
    expect("fetch" in service).toBe(false);
    for (const input of [
      null,
      { ...scope, allowed: true },
      { ...scope, environmentId: "invalid" },
      scope,
    ]) {
      await expect(service.read(input)).rejects.toThrow("Runtime credit admission is unavailable");
    }
    // The probe window is separate scoped RPC: it needs its own Core capability and an exact scope.
    const probeScope = {
      organizationId: scope.organizationId,
      projectId: scope.projectId,
      environmentId: scope.environmentId,
      deploymentId: "01H00000000000000000000804",
    };
    for (const input of [
      null,
      { ...probeScope, includePaidPlan: true },
      { ...probeScope, deploymentId: "invalid" },
      probeScope,
    ]) {
      await expect(service.beginProbe(input)).rejects.toThrow(
        "Runtime probe accounting is unavailable",
      );
    }
  });

  it("fails closed at the project redemption limiter before key parsing, Core access, digest, or SQL", async () => {
    const ticket = "A".repeat(43);
    const keys: string[] = [];
    let coreRead = false;
    workerState.env = {
      get DEV_ACCESS_RUNTIME() {
        coreRead = true;
        throw new Error("must not read");
      },
      PUBLIC_ENTRY_RATE_LIMITER: { limit: vi.fn().mockResolvedValue({ success: true }) },
      CONTROL_API_RATE_LIMITER: {
        limit: vi.fn(async ({ key }: { key: string }) => {
          keys.push(key);
          return { success: false };
        }),
      },
      DEV_ACCESS_SESSION_PRIVATE_JWK: "must-not-parse",
      DEV_ACCESS_SESSION_PUBLIC_JWK: "must-not-parse",
    };
    const { DevAccessService } = await import("../src/worker-main.js");
    const service = new DevAccessService({} as never, workerState.env as never);
    const request = {
      ticket,
      projectId: "01H00000000000000000000802" as never,
      environmentId: "01H00000000000000000000803" as never,
      handle: "calm-otter-waves",
      origin: "https://dev-calm-otter-waves.dev.check.omh.st",
      clientAddress: "198.51.100.7",
    };

    const attempts = await Promise.allSettled(
      Array.from({ length: 20 }, () => service.redeem(request)),
    );
    expect(attempts.every((attempt) => attempt.status === "rejected")).toBe(true);
    expect(coreRead).toBe(false);
    expect(keys.every((key) => !key.includes(ticket))).toBe(true);
    expect(new Set(keys)).toEqual(new Set(["dev-access:redeem:01H00000000000000000000802"]));
  });

  it("bounds one client's redemption flood per project before the shared project bound", async () => {
    // Per-key budgets: three per client-and-project key, ten per project key.
    const spent = new Map<string, number>();
    let coreReads = 0;
    workerState.env = {
      get DEV_ACCESS_RUNTIME() {
        coreReads++;
        throw new Error("Core unavailable in this test");
      },
      CONTROL_API_RATE_LIMITER: {
        limit: vi.fn(async ({ key }: { key: string }) => {
          spent.set(key, (spent.get(key) ?? 0) + 1);
          return { success: (spent.get(key) ?? 0) <= 10 };
        }),
      },
      PUBLIC_ENTRY_RATE_LIMITER: {
        limit: vi.fn(async ({ key }: { key: string }) => {
          spent.set(key, (spent.get(key) ?? 0) + 1);
          return { success: (spent.get(key) ?? 0) <= 3 };
        }),
      },
      DEV_ACCESS_SESSION_PRIVATE_JWK: "{}",
      DEV_ACCESS_SESSION_PUBLIC_JWK: "{}",
    };
    const { DevAccessService } = await import("../src/worker-main.js");
    const service = new DevAccessService({} as never, workerState.env as never);
    const project = {
      projectId: "01H00000000000000000000802" as never,
      environmentId: "01H00000000000000000000803" as never,
      handle: "calm-otter-waves",
      origin: "https://dev-calm-otter-waves.dev.check.omh.st",
    };
    // One client floods project A: its own client bound refuses the last two before the project bound.
    for (let attempt = 0; attempt < 5; attempt++) {
      await expect(
        service.redeem({ ...project, ticket: "A".repeat(43), clientAddress: "198.51.100.7" }),
      ).rejects.toThrow(
        attempt < 3 ? "Dev access redemption is unavailable" : "Dev access rate limit exceeded",
      );
    }
    expect(coreReads).toBe(3);
    expect(spent.get("dev-access:redeem:01H00000000000000000000802")).toBe(3);
    // Another client still redeems project A: the flood spent only the flooder's client bound.
    await expect(
      service.redeem({ ...project, ticket: "B".repeat(43), clientAddress: "198.51.100.8" }),
    ).rejects.toThrow("Dev access redemption is unavailable");
    expect(coreReads).toBe(4);
  });

  it("keeps anonymous redemption floods of one project off other projects and runtime probes", async () => {
    // Each key has its own budget of three, like one Cloudflare rate-limit key.
    const spent = new Map<string, number>();
    let coreReads = 0;
    workerState.env = {
      get DEV_ACCESS_RUNTIME() {
        coreReads++;
        throw new Error("Core unavailable in this test");
      },
      PUBLIC_ENTRY_RATE_LIMITER: {
        limit: vi.fn(async ({ key }: { key: string }) => {
          spent.set(key, (spent.get(key) ?? 0) + 1);
          return { success: true };
        }),
      },
      CONTROL_API_RATE_LIMITER: {
        limit: vi.fn(async ({ key }: { key: string }) => {
          spent.set(key, (spent.get(key) ?? 0) + 1);
          return { success: (spent.get(key) ?? 0) <= 3 };
        }),
      },
      DEV_ACCESS_SESSION_PRIVATE_JWK: "{}",
      DEV_ACCESS_SESSION_PUBLIC_JWK: "{}",
    };
    const { DevAccessService } = await import("../src/worker-main.js");
    const service = new DevAccessService({} as never, workerState.env as never);
    const projectA = {
      projectId: "01H00000000000000000000802" as never,
      environmentId: "01H00000000000000000000803" as never,
      handle: "calm-otter-waves",
      origin: "https://dev-calm-otter-waves.dev.check.omh.st",
    };
    // More than the budget of random tickets for project A exhausts only project A's redemption key:
    // the first three reach Core, the last two are refused by the limiter before Core.
    for (let attempt = 0; attempt < 5; attempt++)
      await expect(
        service.redeem({ ...projectA, ticket: "A".repeat(43), clientAddress: "198.51.100.7" }),
      ).rejects.toThrow(
        attempt < 3 ? "Dev access redemption is unavailable" : "Dev access rate limit exceeded",
      );
    expect(coreReads).toBe(3);
    // A valid redemption on project B and a runtime probe still pass the limiter and reach Core.
    await expect(
      service.redeem({
        ...projectA,
        projectId: "01H00000000000000000000899" as never,
        ticket: "B".repeat(43),
        clientAddress: "198.51.100.7",
      }),
    ).rejects.toThrow("Dev access redemption is unavailable");
    expect(coreReads).toBe(4);
    await expect(
      service.issueRuntimeProbe({
        ...projectA,
        organizationId: "01H00000000000000000000801",
        operationId: "01H00000000000000000000804",
        deploymentId: "01H00000000000000000000805",
        path: "/health",
        method: "GET",
      }),
    ).rejects.toThrow("Dev runtime probe issuance is unavailable");
    expect(coreReads).toBe(5);
    expect([...spent.keys()].sort()).toEqual([
      "dev-access:probe",
      "dev-access:redeem-client:01H00000000000000000000802:198.51.100.7",
      "dev-access:redeem-client:01H00000000000000000000899:198.51.100.7",
      "dev-access:redeem:01H00000000000000000000802",
      "dev-access:redeem:01H00000000000000000000899",
    ]);
  });

  it("fails closed when the private limiter is unavailable without reading the Core binding", async () => {
    let coreRead = false;
    workerState.env = {
      get DEV_ACCESS_RUNTIME() {
        coreRead = true;
        throw new Error("must not read");
      },
      PUBLIC_ENTRY_RATE_LIMITER: { limit: vi.fn().mockResolvedValue({ success: true }) },
      CONTROL_API_RATE_LIMITER: { limit: vi.fn().mockRejectedValue(new Error("limiter down")) },
      DEV_ACCESS_SESSION_PRIVATE_JWK: "must-not-parse",
      DEV_ACCESS_SESSION_PUBLIC_JWK: "must-not-parse",
    };
    const { DevAccessService } = await import("../src/worker-main.js");
    const service = new DevAccessService({} as never, workerState.env as never);
    await expect(
      service.authorize({
        sessionToken: "signed-session",
        projectId: "01H00000000000000000000802" as never,
        environmentId: "01H00000000000000000000803" as never,
        handle: "calm-otter-waves",
        origin: "https://dev-calm-otter-waves.dev.check.omh.st",
      }),
    ).rejects.toThrow("Dev access authorization is unavailable");
    expect(coreRead).toBe(false);
  });

  it("bounds Dev page authorization per session and anonymous requests on their own project key", async () => {
    let coreReads = 0;
    // Each key has its own budget of three, like one Cloudflare rate-limit key.
    const spent = new Map<string, number>();
    workerState.env = {
      get DEV_ACCESS_RUNTIME() {
        coreReads++;
        throw new Error("Core unavailable in this test");
      },
      PUBLIC_ENTRY_RATE_LIMITER: { limit: vi.fn().mockResolvedValue({ success: true }) },
      CONTROL_API_RATE_LIMITER: {
        limit: vi.fn(async ({ key }: { key: string }) => {
          spent.set(key, (spent.get(key) ?? 0) + 1);
          return { success: (spent.get(key) ?? 0) <= 3 };
        }),
      },
      DEV_ACCESS_SESSION_PRIVATE_JWK: "{}",
      DEV_ACCESS_SESSION_PUBLIC_JWK: "{}",
    };
    const { DevAccessService } = await import("../src/worker-main.js");
    const service = new DevAccessService({} as never, workerState.env as never);
    const scope = {
      projectId: "01H00000000000000000000802" as never,
      environmentId: "01H00000000000000000000803" as never,
      handle: "calm-otter-waves",
      origin: "https://dev-calm-otter-waves.dev.check.omh.st",
    };
    // Anonymous asset traffic exhausts its own budget: the fourth request is refused before
    // it reaches the Core.
    for (let request = 0; request < 4; request++)
      await expect(service.authorize({ ...scope, sessionToken: null })).rejects.toThrow(
        "Dev access authorization is unavailable",
      );
    expect(coreReads).toBe(3);
    // Redemption and runtime-probe issuance keep their budget and still reach Control.
    await expect(
      service.redeem({ ...scope, ticket: "A".repeat(43), clientAddress: "198.51.100.7" }),
    ).rejects.toThrow("Dev access redemption is unavailable");
    await expect(
      service.issueRuntimeProbe({
        ...scope,
        organizationId: "01H00000000000000000000801",
        operationId: "01H00000000000000000000804",
        deploymentId: "01H00000000000000000000805",
        path: "/health",
        method: "GET",
      }),
    ).rejects.toThrow("Dev runtime probe issuance is unavailable");
    expect(coreReads).toBe(5);
    // One visitor's session spends its own bound, not the exhausted anonymous one.
    await expect(service.authorize({ ...scope, sessionToken: "signed-session" })).rejects.toThrow(
      "Dev access authorization is unavailable",
    );
    expect(coreReads).toBe(6);
    const digest = Buffer.from(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode("signed-session")),
    ).toString("hex");
    expect([...spent.keys()].sort()).toEqual([
      "dev-access:anonymous:01H00000000000000000000802",
      "dev-access:probe",
      "dev-access:redeem:01H00000000000000000000802",
      `dev-access:session:${digest}`,
    ]);
    const before = coreReads;
    await expect(
      service.authorize({
        ...scope,
        organizationHint: "01H00000000000000000000801" as never,
        sessionToken: "hinted-session",
      }),
    ).rejects.toThrow("Dev access authorization is unavailable");
    const hintedDigest = Buffer.from(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode("hinted-session")),
    ).toString("hex");
    expect(spent.get(`dev-access:session:${hintedDigest}`)).toBe(1);
    expect(coreReads).toBe(before + 1);
  });

  it("rate-limits runtime-probe issuance before reading the Core binding or signing keys", async () => {
    let coreRead = false;
    workerState.env = {
      get DEV_ACCESS_RUNTIME() {
        coreRead = true;
        throw new Error("must not read");
      },
      PUBLIC_ENTRY_RATE_LIMITER: { limit: vi.fn().mockResolvedValue({ success: true }) },
      CONTROL_API_RATE_LIMITER: { limit: vi.fn().mockResolvedValue({ success: false }) },
      DEV_ACCESS_SESSION_PRIVATE_JWK: "must-not-parse",
      DEV_ACCESS_SESSION_PUBLIC_JWK: "must-not-parse",
    };
    const { DevAccessService } = await import("../src/worker-main.js");
    const service = new DevAccessService({} as never, workerState.env as never);
    await expect(
      service.issueRuntimeProbe({
        organizationId: "01H00000000000000000000801",
        projectId: "01H00000000000000000000802",
        environmentId: "01H00000000000000000000803",
        operationId: "01H00000000000000000000804",
        deploymentId: "01H00000000000000000000805",
        handle: "calm-otter-waves",
        origin: "https://dev-calm-otter-waves.dev.check.omh.st",
        path: "/health",
        method: "GET",
      }),
    ).rejects.toThrow("Dev runtime probe issuance is unavailable");
    expect(coreRead).toBe(false);
  });

  it("rejects malformed signing-key JSON after rate limiting but before Core access", async () => {
    let coreRead = false;
    workerState.env = {
      get DEV_ACCESS_RUNTIME() {
        coreRead = true;
        throw new Error("must not read");
      },
      CONTROL_API_RATE_LIMITER: { limit: vi.fn().mockResolvedValue({ success: true }) },
      PUBLIC_ENTRY_RATE_LIMITER: { limit: vi.fn().mockResolvedValue({ success: true }) },
      DEV_ACCESS_SESSION_PRIVATE_JWK: "{",
      DEV_ACCESS_SESSION_PUBLIC_JWK: "{}",
    };
    const { DevAccessService } = await import("../src/worker-main.js");
    const service = new DevAccessService({} as never, workerState.env as never);

    await expect(
      service.redeem({
        ticket: "A".repeat(43),
        projectId: "01H00000000000000000000802" as never,
        environmentId: "01H00000000000000000000803" as never,
        handle: "calm-otter-waves",
        origin: "https://dev-calm-otter-waves.dev.check.omh.st",
        clientAddress: "198.51.100.7",
      }),
    ).rejects.toThrow("Dev access redemption is unavailable");
    expect(coreRead).toBe(false);
  });

  it("accepts only the exact custom dev origin at the private RPC boundary", async () => {
    const { parseDevAccessAuthorizeInput, parseDevAccessRedeemInput } = await import(
      "../src/dev-access.js"
    );
    const exact = {
      projectId: "01H00000000000000000000802",
      environmentId: "01H00000000000000000000803",
      handle: "calm-otter-waves",
      origin: "https://dev-calm-otter-waves.dev.check.omh.st",
    };
    expect(
      parseDevAccessRedeemInput({
        ...exact,
        clientAddress: "198.51.100.7",
        ticket: "A".repeat(43),
      }),
    ).toMatchObject(exact);
    expect(
      parseDevAccessAuthorizeInput({ ...exact, sessionToken: "payload.signature" }),
    ).toMatchObject(exact);
    for (const origin of [
      "https://dev-calm-otter-waves.your-omh-account.workers.dev",
      "https://dev-calm-otter-waves.attacker.example",
    ]) {
      expect(() =>
        parseDevAccessRedeemInput({
          ...exact,
          clientAddress: "198.51.100.7",
          origin,
          ticket: "A".repeat(43),
        }),
      ).toThrow("Dev access redemption input is invalid");
      expect(() =>
        parseDevAccessAuthorizeInput({ ...exact, origin, sessionToken: "payload.signature" }),
      ).toThrow("Dev access authorization input is invalid");
    }
  });
});
