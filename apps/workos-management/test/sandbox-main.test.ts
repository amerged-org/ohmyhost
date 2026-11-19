import { describe, expect, it } from "vitest";

import { runSandboxSelfTest } from "../src/sandbox-main.js";

describe("digest-bound management sandbox self-test", () => {
  it("exercises the Worker resolver, read-only transport, and private RPC without external I/O", async () => {
    const digest = "a".repeat(64);
    await expect(runSandboxSelfTest(digest)).resolves.toEqual({
      schema_version: "workos-management-sandbox-self-test-v1",
      artifact_sha256: digest,
      components: {
        resolver: "configured",
        transport: "read_only",
        rpc: "authenticated",
      },
    });
  });

  it("rejects malformed artifact digests before composing the graph", async () => {
    await expect(runSandboxSelfTest("not-a-digest")).rejects.toThrow("digest");
  });
});
