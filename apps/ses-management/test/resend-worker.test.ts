import { describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({
  WorkerEntrypoint: class {
    public readonly env: unknown;
    constructor(_context: unknown, env: unknown) {
      this.env = env;
    }
  },
}));
import worker, { ResendMailManagementService } from "../src/resend-worker.js";

const unconfigured = { RUNTIME_CONFIGURATION_STATE: "disabled" } as never;

describe("Resend management Worker entrypoint", () => {
  it("serves no HTTP route", async () => {
    expect((await worker.fetch()).status).toBe(404);
  });
  it("reaches the manager for every RPC and refuses an unconfigured runtime before any binding", async () => {
    const service = new ResendMailManagementService({}, unconfigured);
    // Each operation validates its request first; a malformed one never reaches storage or the provider.
    for (const call of [
      service.ensureWorkspaceMailDomain,
      service.syncWorkspaceMailDomain,
      service.retireWorkspaceMailDomain,
      service.configureMailDomain,
      service.readMailDomain,
      service.prepareMailWebhook,
      service.verifyMailWebhook,
      service.rotateMailWebhook,
      service.disableMailReceiving,
      service.deleteMailDomain,
      service.ensureMailDomain,
    ])
      await expect(call.call(service, null)).rejects.toThrow("Invalid mail request");
    for (const call of [
      () => service.deleteMailProject({}),
      () => worker.scheduled({}, unconfigured),
    ])
      await expect(call()).rejects.toThrow("Mail management configuration unavailable");
  });
});
