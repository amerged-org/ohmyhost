import { PassThrough } from "node:stream";
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { expect, it, vi } from "vitest";

it("cancels real CLI requests through each one-shot process signal and emits only safe output", async () => {
  const outputDescriptor = Object.getOwnPropertyDescriptor(process, "stdout");
  const errorDescriptor = Object.getOwnPropertyDescriptor(process, "stderr");
  if (!outputDescriptor || !errorDescriptor) throw new Error("Process streams are unavailable");
  const originalArgs = process.argv,
    originalExit = process.exitCode;
  const originalEnvironment = process.env["OHMYHOST_ENVIRONMENT"],
    originalToken = process.env["OHMYHOST_TOKEN"];
  const originalDispatcher = getGlobalDispatcher();
  const token = `sk_${"entry-fixture-".repeat(3)}`;
  const output = new PassThrough(),
    errors = new PassThrough();
  let stdout = "",
    stderr = "";
  output.on("data", (chunk) => {
    stdout += String(chunk);
  });
  errors.on("data", (chunk) => {
    stderr += String(chunk);
  });
  const originalSignals = new Map(
    (["SIGINT", "SIGTERM"] as const).map((signal) => [
      signal,
      new Set(process.rawListeners(signal)),
    ]),
  );
  const removeAddedListeners = () => {
    for (const [signal, before] of originalSignals)
      for (const listener of process.rawListeners(signal))
        if (!before.has(listener)) process.removeListener(signal, listener as () => void);
  };
  try {
    Object.defineProperty(process, "stdout", { configurable: true, value: output });
    Object.defineProperty(process, "stderr", { configurable: true, value: errors });
    process.env["OHMYHOST_ENVIRONMENT"] = "development";
    process.env["OHMYHOST_TOKEN"] = token;
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      const http = new MockAgent();
      http.disableNetConnect();
      setGlobalDispatcher(http);
      let requested = 0;
      http
        .get("https://dev.app.ohmyho.st")
        .intercept({ path: "/v1/me", method: "GET", headers: { authorization: `Bearer ${token}` } })
        .reply(() => {
          requested++;
          return {
            statusCode: 200,
            data: {
              actor_id: "user:fixture",
              email: "fixture@example.test",
              organization_ids: ["00000000000000000000000001"],
              organizations: [{ id: "00000000000000000000000001", name: "Fixture" }],
            },
          };
        })
        .delay(5000);
      try {
        stdout = "";
        stderr = "";
        process.argv = [process.execPath, "ohmyhost", "whoami", "--json"];
        vi.resetModules();
        const invocation = import("../src/bin.js");
        await vi.waitFor(() => expect(requested).toBe(1));
        const added = process
          .rawListeners(signal)
          .filter((listener) => !originalSignals.get(signal)?.has(listener));
        expect(added).toHaveLength(1);
        const listener = added[0];
        if (!listener) throw new Error("Missing process signal handler");
        listener();
        await invocation;
        expect(process.exitCode).toBe(130);
        expect(JSON.parse(stdout)).toMatchObject({
          command: "whoami",
          status: "error",
          error: { code: "command_cancelled" },
        });
        expect(stderr).toContain("cancelled/runtime/cancelled");
        expect(stdout + stderr).not.toContain(token);
        expect(process.rawListeners(signal)).not.toContain(listener);
        http.assertNoPendingInterceptors();
      } finally {
        removeAddedListeners();
        await http.close();
      }
    }
  } finally {
    removeAddedListeners();
    setGlobalDispatcher(originalDispatcher);
    Object.defineProperty(process, "stdout", outputDescriptor);
    Object.defineProperty(process, "stderr", errorDescriptor);
    process.argv = originalArgs;
    process.exitCode = originalExit;
    if (originalEnvironment === undefined) delete process.env["OHMYHOST_ENVIRONMENT"];
    else process.env["OHMYHOST_ENVIRONMENT"] = originalEnvironment;
    if (originalToken === undefined) delete process.env["OHMYHOST_TOKEN"];
    else process.env["OHMYHOST_TOKEN"] = originalToken;
    output.destroy();
    errors.destroy();
    vi.resetModules();
  }
}, 15000);

it("passes OHMYHOST_PROFILE to the CLI binary the way the MCP server receives it", async () => {
  // Without it, a process bound to one saved login got profile_selection_required, whose own text
  // told the agent to set this very variable.
  const outputDescriptor = Object.getOwnPropertyDescriptor(process, "stdout");
  if (!outputDescriptor) throw new Error("Process stdout is unavailable");
  const originalArgs = process.argv,
    originalExit = process.exitCode;
  const names = ["OHMYHOST_ENVIRONMENT", "OHMYHOST_TOKEN", "OHMYHOST_PROFILE"] as const;
  const original = new Map(names.map((name) => [name, process.env[name]]));
  const output = new PassThrough();
  let stdout = "";
  output.on("data", (chunk) => {
    stdout += String(chunk);
  });
  try {
    Object.defineProperty(process, "stdout", { configurable: true, value: output });
    process.env["OHMYHOST_ENVIRONMENT"] = "development";
    delete process.env["OHMYHOST_TOKEN"];
    process.env["OHMYHOST_PROFILE"] = "Not A Name";
    process.argv = [process.execPath, "ohmyhost", "whoami", "--json"];
    vi.resetModules();
    await import("../src/bin.js");

    expect(process.exitCode).toBe(2);
    expect(JSON.parse(stdout)).toMatchObject({
      command: "whoami",
      status: "error",
      error: { code: "invalid_profile_binding", retryable: false },
    });
  } finally {
    Object.defineProperty(process, "stdout", outputDescriptor);
    process.argv = originalArgs;
    process.exitCode = originalExit;
    for (const [name, value] of original) {
      if (value === undefined) Reflect.deleteProperty(process.env, name);
      else process.env[name] = value;
    }
    output.destroy();
    vi.resetModules();
  }
});
