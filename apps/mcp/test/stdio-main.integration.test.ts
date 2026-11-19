import { PassThrough } from "node:stream";
import { readFileSync } from "node:fs";
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { expect, it, vi } from "vitest";

it("runs the actual stdio entry through discovery, authenticated REST and transport teardown", async () => {
  const descriptors = new Map(
    (["stdin", "stdout", "stderr"] as const).map((name) => [
      name,
      Object.getOwnPropertyDescriptor(process, name),
    ]),
  );
  if ([...descriptors.values()].some((value) => !value))
    throw new Error("Process streams unavailable");
  const input = new PassThrough(),
    output = new PassThrough(),
    errors = new PassThrough();
  const originalEnvironment = process.env["OHMYHOST_ENVIRONMENT"],
    originalToken = process.env["OHMYHOST_TOKEN"];
  const originalDispatcher = getGlobalDispatcher(),
    http = new MockAgent();
  http.disableNetConnect();
  const token = `sk_${"stdio-fixture-".repeat(3)}`;
  const identity = {
    actor_id: "user:stdio_fixture",
    email: "stdio@example.invalid",
    organization_ids: ["00000000000000000000000001"],
    organizations: [{ id: "00000000000000000000000001", name: "Stdio workspace" }],
  };
  http
    .get("https://dev.app.ohmyho.st")
    .intercept({ path: "/v1/me", method: "GET", headers: { authorization: `Bearer ${token}` } })
    .reply(200, identity, { headers: { "content-type": "application/json" } });
  let stdout = "",
    stderr = "";
  output.on("data", (chunk) => {
    stdout += String(chunk);
  });
  errors.on("data", (chunk) => {
    stderr += String(chunk);
  });
  const messages = () =>
    stdout
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  const send = (value: unknown) => input.write(JSON.stringify(value) + "\n");
  try {
    for (const [name, stream] of [
      ["stdin", input],
      ["stdout", output],
      ["stderr", errors],
    ] as const)
      Object.defineProperty(process, name, { configurable: true, value: stream });
    process.env["OHMYHOST_ENVIRONMENT"] = "development";
    process.env["OHMYHOST_TOKEN"] = token;
    setGlobalDispatcher(http);
    vi.resetModules();
    await import("../src/stdio-main.js");
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "stdio-entry-test", version: "1" },
      },
    });
    await vi.waitFor(() => expect(messages().some((message) => message.id === 1)).toBe(true));
    const version = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ).version;
    expect(messages().find((message) => message.id === 1)).toMatchObject({
      result: { serverInfo: { name: "ohmyhost-local", version } },
    });
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "identity_get", arguments: {} },
    });
    await vi.waitFor(() => expect(messages().some((message) => message.id === 2)).toBe(true));
    const result = messages().find((message) => message.id === 2).result;
    expect(result.isError).not.toBe(true);
    expect(JSON.parse(result.content[0].text)).toEqual({
      ...identity,
      context: { credential: "environment_token", profile: null },
    });
    http.assertNoPendingInterceptors();
    // The entry lists this computer's saved logins from their index below the home directory,
    // which the test setup replaces; with OHMYHOST_TOKEN no credential store is read at all.
    send({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "profile_list", arguments: {} },
    });
    await vi.waitFor(() => expect(messages().some((message) => message.id === 3)).toBe(true));
    const listed = messages().find((message) => message.id === 3).result;
    expect(listed.isError).not.toBe(true);
    expect(JSON.parse(listed.content[0].text)).toEqual({
      profiles: [],
      bound: null,
      environment_token: true,
    });
    expect(stdout).not.toContain(token);
    output.emit("error", new Error("controlled-stdio-output-failure"));
    await vi.waitFor(() => expect(input.listenerCount("data")).toBe(0));
    expect(stderr).toContain("controlled-stdio-output-failure");
    expect(messages()).toHaveLength(3);
  } finally {
    for (const [name, descriptor] of descriptors)
      if (descriptor) Object.defineProperty(process, name, descriptor);
    if (originalEnvironment === undefined) delete process.env["OHMYHOST_ENVIRONMENT"];
    else process.env["OHMYHOST_ENVIRONMENT"] = originalEnvironment;
    if (originalToken === undefined) delete process.env["OHMYHOST_TOKEN"];
    else process.env["OHMYHOST_TOKEN"] = originalToken;
    setGlobalDispatcher(originalDispatcher);
    input.destroy();
    output.destroy();
    errors.destroy();
    await http.close();
    vi.resetModules();
  }
}, 15000);
