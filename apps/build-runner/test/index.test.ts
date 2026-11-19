import { describe, expect, it, vi } from "vitest";

const workerState = vi.hoisted(() => ({ env: undefined as unknown }));

vi.mock("cloudflare:workers", () => ({
  WorkerEntrypoint: class {
    public readonly env = workerState.env;
  },
}));
vi.mock("@cloudflare/containers", async () => ({
  Container: (await import("./doubles.js")).ContainerBaseDouble,
}));

describe("build runner public entrypoint", () => {
  it("exposes the closed private service, the sandbox object and the persisting composition", async () => {
    const api = await import("../src/index.js");

    expect(() => api.createPersistingBuildBroker({} as never, {} as never, {} as never)).toThrow(
      "build_runner_configuration_invalid",
    );
    expect(() => api.createBuildRunnerRuntime({} as never, "ohmyho-builds-test")).toThrow(
      "build_runner_configuration_invalid",
    );
    expect(api.BuildSandbox.name).toBe("BuildSandbox");
    expect(api.BuildSandboxEu.name).toBe("BuildSandboxEu");
    expect(Object.getPrototypeOf(api.BuildSandboxEu)).toBe(api.BuildSandbox);

    const service = new api.BuildRunnerService({} as never, {} as never);
    await expect(
      service.removeArchive({ bucketOverride: "forbidden-public-entrypoint-override" } as never),
    ).rejects.toMatchObject({ code: "build_broker_input_invalid" });
  });
});
