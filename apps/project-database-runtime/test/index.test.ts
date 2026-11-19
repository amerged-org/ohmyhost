import { describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({
  RpcTarget: class {
    protected readonly rpc = true;
  },
  DurableObject: class {
    readonly kind = "test-durable-object";
  },
  WorkerEntrypoint: class {
    readonly kind = "test-worker-entrypoint";
  },
}));

import * as projectDatabaseRuntime from "../src/index.js";

describe("project database runtime public API", () => {
  it("exports the HTTP, RPC, and database service entrypoints from the package root", () => {
    expect(projectDatabaseRuntime).toEqual(
      expect.objectContaining({
        ProjectDatabaseService: expect.any(Function),
        createProjectDatabaseHttpWorker: expect.any(Function),
        createProjectDatabaseService: expect.any(Function),
      }),
    );
  });
});
