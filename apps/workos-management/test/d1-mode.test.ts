import { describe, expect, it, vi } from "vitest";

import {
  CONTROL_RUNTIME_IDENTITY_METHODS,
  ControlRuntimeUnavailableError,
  createD1WorkosIdentityPort,
  requireControlRuntimeBinding,
} from "../src/d1-identity-port.js";
import { createD1WorkosManagementDatabase } from "../src/d1-management-database.js";
import { UserApiKeyRequestError } from "../src/identity-port.js";
import { parseWorkosManagementWorkerBindings } from "../src/worker-runtime.js";
import {
  createWorkosManagementWorkerEntrypoint,
  CreditWarningRecipientsService,
} from "../src/worker-main.js";

// Host-runtime adapter only; the entrypoint classes are exercised with real parsing and composition.
vi.mock("cloudflare:workers", () => ({
  WorkerEntrypoint: class {
    constructor(
      _context: unknown,
      protected readonly env: unknown,
    ) {}
  },
}));

const common = {
  WORKOS_DEPLOYMENT: "development",
  WORKOS_MANAGEMENT_CREDENTIAL: "test-workos-management",
  MANAGEMENT_ARTIFACT_SHA256: "a".repeat(64),
  CF_VERSION_METADATA: {
    id: "095f00a7-23a7-43b7-a227-e4c97cab5f22",
    tag: "a".repeat(64),
    timestamp: "2026-10-28T10:00:00.000Z",
  },
} as const;

const d1Bindings = (runtime: unknown = {}): never =>
  ({ ...common, CONTROL_RUNTIME: runtime }) as never;
const d1Record = (runtime: unknown = {}) =>
  ({ ...common, CONTROL_RUNTIME: runtime }) as Record<string, unknown>;

describe("Control service binding", () => {
  it("is the only Control authority the Worker accepts", () => {
    const runtime = { any: "stub" };
    expect(parseWorkosManagementWorkerBindings(d1Bindings(runtime))).toMatchObject({
      CONTROL_RUNTIME: runtime,
    });
  });

  it("fails closed on a missing binding", () => {
    for (const runtime of [undefined, null, "text", 7]) {
      expect(() =>
        parseWorkosManagementWorkerBindings({
          ...common,
          ...(runtime === undefined ? {} : { CONTROL_RUNTIME: runtime }),
        } as never),
      ).toThrow("incomplete");
    }
  });

  it.each(["CONTROL_CORE", "CONTROL_GLOBAL", "CONTROL_SHARD_0001"])(
    "refuses the direct database binding %s next to the service binding",
    (name) => {
      expect(() =>
        parseWorkosManagementWorkerBindings({ ...d1Record(), [name]: "x" } as never),
      ).toThrow("incomplete");
    },
  );
});

describe("D1 identity port over a service binding", () => {
  it("lists every ControlRuntime method the consumer calls", () => {
    expect([...CONTROL_RUNTIME_IDENTITY_METHODS].sort()).toEqual([
      "authorizeUserApiKeyScope",
      "claimUserApiKeyCreation",
      "finishUserApiKeyCreation",
      "isSessionEligible",
      "readSessionRevocation",
      "readUserApiKeyNames",
      "recordTerminalRevocation",
      "recordUserApiKeyRevocationAudit",
    ]);
  });

  it("requires a binding and never treats a missing one as success", () => {
    for (const missing of [undefined, null, "x", 1]) {
      expect(() => requireControlRuntimeBinding(missing)).toThrow(ControlRuntimeUnavailableError);
      expect(() => createD1WorkosIdentityPort({ runtime: missing })).toThrow(
        "control_runtime_unavailable",
      );
    }
    expect(new ControlRuntimeUnavailableError().code).toBe("control_runtime_unavailable");
    const stub = {};
    expect(requireControlRuntimeBinding(stub)).toBe(stub);
    expect(requireControlRuntimeBinding(() => undefined)).toBeTypeOf("function");
  });

  it("calls each method on the binding itself and maps a command refusal to the closed error", async () => {
    const calls: [string, unknown][] = [];
    const binding = {
      authorizeUserApiKeyScope(input: unknown) {
        calls.push(["authorize", this === binding]);
        return Promise.resolve(input);
      },
      claimUserApiKeyCreation: async (input: unknown) => {
        calls.push(["claim", input]);
        return { action: "create" };
      },
      finishUserApiKeyCreation: async (input: unknown) => calls.push(["finish", input]),
      readUserApiKeyNames: async () => new Map([["api_key_1", "name"]]),
      recordUserApiKeyRevocationAudit: async (input: unknown) => calls.push(["audit", input]),
      readSessionRevocation: async () => ({ workosUserId: "user_a" }),
      recordTerminalRevocation: async () => "created" as const,
      isSessionEligible: async () => true,
    };
    const port = createD1WorkosIdentityPort({ runtime: binding });
    await port.authorizeUserApiKeyScope({} as never);
    await port.claimUserApiKeyCreation({ marker: 1 } as never);
    await port.finishUserApiKeyCreation({ marker: 2 } as never);
    await port.recordUserApiKeyRevocationAudit({ marker: 3 } as never);
    expect(
      await port.readUserApiKeyNames({ organizationId: "o", userId: "u", keyIds: ["a"] }),
    ).toEqual(new Map([["api_key_1", "name"]]));
    expect(await port.readSessionRevocation({ sessionId: "s" })).toEqual({
      workosUserId: "user_a",
    });
    expect(await port.recordTerminalRevocation({} as never)).toBe("created");
    expect(await port.isSessionEligible({} as never)).toBe(true);
    expect(calls).toEqual([
      ["authorize", true],
      ["claim", { marker: 1 }],
      ["finish", { marker: 2 }],
      ["audit", { marker: 3 }],
    ]);

    const refusing = (error: unknown) =>
      createD1WorkosIdentityPort({
        runtime: { ...binding, authorizeUserApiKeyScope: async () => Promise.reject(error) },
      }).authorizeUserApiKeyScope({} as never);
    for (const code of [
      "invalid_request",
      "resource_not_found",
      "idempotency_key_reused",
      "result_conflict",
    ]) {
      await expect(refusing(Object.assign(new Error(code), { code }))).rejects.toMatchObject({
        constructor: UserApiKeyRequestError,
        code,
      });
      await expect(refusing(new Error(code))).rejects.toBeInstanceOf(UserApiKeyRequestError);
    }
    const unknown = new Error("network lost");
    await expect(refusing(unknown)).rejects.toBe(unknown);
    await expect(refusing("plain text")).rejects.toBe("plain text");
    await expect(refusing(null)).rejects.toBeNull();
  });
});

describe("D1 management database", () => {
  it("delegates session eligibility and every supplied poller capability without a database", async () => {
    const isSessionEligible = vi.fn(async () => true);
    const methods = [
      "findExpiredFinalClaim",
      "claim",
      "applySnapshotAndAcknowledge",
      "applyDeletionAndAcknowledge",
      "revokeLocalAuthorizationForUncertainSnapshot",
      "recordFailure",
      "recoverExpiredFinalClaim",
    ] as const;
    const calls = Object.fromEntries(methods.map((method) => [method, vi.fn(async () => null)]));
    const database = createD1WorkosManagementDatabase({ isSessionEligible }, calls as never);
    expect(await database.isSessionEligible({ sessionId: "s" } as never)).toBe(true);
    expect(isSessionEligible).toHaveBeenCalledOnce();
    for (const method of methods) {
      const input = { marker: method };
      await (database[method] as (input: unknown) => Promise<unknown>)(input);
      expect(calls[method]).toHaveBeenCalledWith(input);
    }
  });
});

describe("Worker entrypoint over the service binding", () => {
  const fetcher = async () => new Response("{}");

  it("serves only through the service binding and returns the artifact headers", async () => {
    const entrypoint = createWorkosManagementWorkerEntrypoint({ fetcher });
    const runtime = {
      isSessionEligible: vi.fn(async () => false),
    };
    const response = await entrypoint.fetch(
      new Request("https://internal/session-status", {
        method: "POST",
        body: JSON.stringify({
          sessionId: "session_1",
          userId: "user_1",
          organizationId: "org_1",
          tokenExpiresAt: 4_102_444_800,
        }),
      }),
      d1Bindings(runtime),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ active: false });
    expect(runtime.isSessionEligible).toHaveBeenCalledOnce();
    expect(response.headers.get("x-ohmyhost-management-artifact-sha256")).toBe("a".repeat(64));
  });

  it("composes the onboarding route and validates its body before any persistence", async () => {
    const response = await createWorkosManagementWorkerEntrypoint({ fetcher }).fetch(
      new Request("https://internal/organizations", { method: "POST", body: "{}" }),
      d1Bindings({}),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: { code: "invalid_request" } });
  });

  it("answers unavailable for an invalid binding set, an unusable composition and a scheduled run", async () => {
    const entrypoint = createWorkosManagementWorkerEntrypoint({ fetcher });
    const request = () => new Request("https://internal/rpc", { method: "POST", body: "{}" });
    const missing = await entrypoint.fetch(request(), { ...common } as never);
    expect(missing.status).toBe(503);
    const broken = createWorkosManagementWorkerEntrypoint({
      fetcher,
      runtimeFactory: () => {
        throw new Error("composition failed");
      },
    });
    expect((await broken.fetch(request(), d1Bindings({}))).status).toBe(503);
    const scheduled = await entrypoint.scheduled(
      { cron: "*/1 * * * *", scheduledTime: 0 },
      d1Bindings({}),
    );
    expect(scheduled).toEqual({ ok: false, error: { code: "unavailable" } });
  });

  it("validates credit-warning input before reading any persistence", async () => {
    const service = new CreditWarningRecipientsService({}, d1Bindings({}));
    await expect(service.resolve({})).rejects.toThrow("credit_warning_invalid");
  });
});
