import { describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({
  // The mock needs only the inheritance surface used by the Worker entrypoint.
  // eslint-disable-next-line @typescript-eslint/no-extraneous-class
  RpcTarget: class {},
  DurableObject: class {
    constructor(
      protected readonly ctx: unknown,
      protected readonly env: unknown,
    ) {}
  },
  WorkerEntrypoint: class {
    protected readonly env: unknown;

    constructor(_context: unknown, env: unknown) {
      this.env = env;
    }
  },
}));

import * as workerMain from "../src/worker-main.js";

describe("project database Worker RPC exports", () => {
  it("exports separate customer, administrator and physical environment boundaries", () => {
    expect(workerMain.ProjectDatabaseService).toBeTypeOf("function");
    expect(workerMain.ProjectDatabaseAdmin).toBeTypeOf("function");
    expect(workerMain.ProjectDatabaseEnvironment).toBeTypeOf("function");
    expect(workerMain.ProjectDatabaseQa).toBeTypeOf("function");
    expect(workerMain.default.fetch().status).toBe(404);
    expect("ProjectDatabaseConnection" in workerMain).toBe(false);
  });
});
