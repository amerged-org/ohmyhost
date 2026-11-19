import { describe, expect, it, vi } from "vitest";

const handlers = vi.hoisted(() => ({
  resolve: vi.fn(async (input: unknown) => ({ input, kind: "lookup" })),
  activate: vi.fn(async (input: unknown) => ({ input, kind: "activate" })),
  observe: vi.fn(async (input: unknown) => ({ input, kind: "observe" })),
  remove: vi.fn(async (input: unknown) => ({ input, kind: "remove" })),
  compensate: vi.fn(async (input: unknown) => ({ input, kind: "compensate" })),
  authorizeCandidateRemoval: vi.fn(async (input: unknown) => ({
    input,
    kind: "candidate-removal",
  })),
}));
const createHandlers = vi.hoisted(() =>
  vi.fn((bindings: unknown) => {
    if (bindings === undefined) throw new Error("Gateway bindings are required");
    return handlers;
  }),
);
vi.mock("cloudflare:workers", () => ({
  WorkerEntrypoint: class {
    protected readonly env: unknown;
    constructor(_context: unknown, env: unknown) {
      this.env = env;
    }
  },
}));
vi.mock("../src/gateway-routing.js", () => ({ createGatewayRoutingHandlers: createHandlers }));

import {
  GatewayRoutingManagementService,
  GatewayRoutingService,
} from "../src/gateway-routing-worker.js";

describe("shared gateway private service bindings", () => {
  it("exposes hostname lookup separately from scoped route mutations", async () => {
    const bindings = {
      DEV_ACCESS_SESSION_PUBLIC_JWK: "private-key-metadata",
    };
    const lookup = new GatewayRoutingService({} as never, bindings);
    const management = new GatewayRoutingManagementService({} as never, bindings);
    const request = { hostname: "calm-river-studio.check.omh.st" };
    await expect(lookup.resolve(request)).resolves.toEqual({ input: request, kind: "lookup" });
    expect("activate" in lookup).toBe(false);
    expect("resolve" in management).toBe(false);

    for (const [method, kind] of [
      ["activate", "activate"],
      ["observe", "observe"],
      ["remove", "remove"],
      ["compensate", "compensate"],
      ["authorizeCandidateRemoval", "candidate-removal"],
    ] as const) {
      const input = { method, scope: "trusted" };
      await expect(management[method](input)).resolves.toEqual({ input, kind });
      expect(handlers[method]).toHaveBeenCalledWith(input);
    }
    expect(createHandlers).toHaveBeenCalledTimes(6);
    for (const [received] of createHandlers.mock.calls) expect(received).toBe(bindings);
  });
});
