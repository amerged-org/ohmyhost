import { beforeEach, describe, expect, it, vi } from "vitest";

/** The only child process the CLI starts is the customer's own psql; nothing else is spawned. */
const child = vi.hoisted(() => {
  const calls: { command: string; args: readonly string[]; options: Record<string, unknown> }[] =
    [];
  const handlers = new Map<string, (...values: readonly never[]) => void>();
  return {
    calls,
    handlers,
    emit: (event: "error" | "close", ...values: readonly unknown[]) =>
      handlers.get(event)?.(...(values as readonly never[])),
    killed: [] as string[],
    spawn: (command: string, args: readonly string[], options: Record<string, unknown>) => {
      calls.push({ command, args, options });
      handlers.clear();
      // Like Node, an aborted spawn signal ends the child with an AbortError.
      const signal = options["signal"] as AbortSignal | undefined;
      signal?.addEventListener("abort", () => handlers.get("error")?.(signal.reason as never));
      return {
        once: (event: string, handler: (...values: readonly never[]) => void) => {
          handlers.set(event, handler);
        },
        kill: (signalName: string) => {
          child.killed.push(signalName);
        },
      };
    },
  };
});
vi.mock("node:child_process", () => ({ spawn: child.spawn }));
const bridge = vi.hoisted(() => ({ opened: 0, closed: 0 }));
vi.mock("@ohmyhost/postgres-bridge", () => ({
  startBridge: async () => {
    bridge.opened++;
    return {
      host: "127.0.0.1",
      port: 55432,
      close: async () => {
        bridge.closed++;
      },
    };
  },
}));

import { PsqlUnavailableError } from "../src/cli.js";
import { runLocalPsql } from "../src/psql-session.js";

const PASSWORD = "3f".repeat(32);
const session = () => ({
  host: "pgcf.example.test",
  user: "ohmyho_da_01h00000000000000000000006_07070707",
  password: PASSWORD,
  database: "dbkx3m9q2w7e5r1t8y4u",
  websocketUrl: "wss://pgcf.example.test/",
  signal: new AbortController().signal,
});

/** The bridge starts asynchronously, so psql only exists once the spawn call has been recorded. */
const launch = async (input = session()) => {
  const expected = child.calls.length + 1;
  const running = runLocalPsql(input);
  await vi.waitFor(() => expect(child.calls).toHaveLength(expected));
  return { running };
};

/** Node reports the terminal through process.stdin.isTTY; each test sets it, so none depends on how vitest was started. */
const setTerminal = (isTerminal: boolean) =>
  Object.defineProperty(process.stdin, "isTTY", { value: isTerminal, configurable: true });

describe("local psql session", () => {
  beforeEach(() => {
    setTerminal(false);
    bridge.opened = 0;
    bridge.closed = 0;
    child.calls.length = 0;
    child.killed.length = 0;
    child.handlers.clear();
  });

  it("hands the password to psql through its private environment, never through argv", async () => {
    const input = session();
    const { running } = await launch(input);
    expect(bridge).toEqual({ opened: 1, closed: 0 });
    const call = child.calls[0];
    if (call === undefined) throw new Error("PGCF psql process was not started");
    expect(call.command).toBe("psql");
    expect(call.args).toEqual(["-h", "127.0.0.1", "-U", input.user, "-d", input.database]);
    expect(JSON.stringify(call.args)).not.toContain(PASSWORD);
    const environment = call.options["env"] as Record<string, string>;
    expect(environment).toMatchObject({
      PGPASSWORD: PASSWORD,
      PGPORT: "55432",
      PGSSLMODE: "disable",
      PGCHANNELBINDING: "disable",
      PGGSSENCMODE: "disable",
    });
    // The customer's own PATH has to survive, or their psql cannot be found at all.
    expect(environment["PATH"]).toBe(process.env["PATH"]);
    expect(call.options["stdio"]).toBe("inherit");
    // The process signal is not handed to psql: Ctrl-C reaches psql, which cancels its own query.
    expect(call.options["signal"]).toBeUndefined();
    child.emit("close", 0, null);
    await expect(running).resolves.toBe(0);
    expect(bridge).toEqual({ opened: 1, closed: 1 });
  });

  it("keeps the session running when the command's signal is aborted, because only psql ends it", async () => {
    const controller = new AbortController();
    const { running } = await launch({ ...session(), signal: controller.signal });
    const outcome = vi.fn();
    running.then(outcome, outcome);
    controller.abort(new DOMException("Cancelled", "AbortError"));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(outcome).not.toHaveBeenCalled();
    expect(bridge).toEqual({ opened: 1, closed: 0 });
    child.emit("close", 0, null);
    await expect(running).resolves.toBe(0);
    expect(bridge).toEqual({ opened: 1, closed: 1 });
  });

  it("terminates psql and ends the session when the process is terminated", async () => {
    const { running } = await launch();
    const terminate = process.listeners("SIGTERM").at(-1);
    if (terminate === undefined) throw new Error("No SIGTERM handler is registered");
    terminate("SIGTERM" as never);
    expect(child.killed).toEqual(["SIGTERM"]);
    child.emit("close", null, "SIGTERM");
    await expect(running).resolves.toBe(130);
    expect(bridge).toEqual({ opened: 1, closed: 1 });
  });

  it("forwards an interrupt sent to this process to psql, so psql ends its own session", async () => {
    const { running } = await launch();
    const interrupt = process.listeners("SIGINT").at(-1);
    if (interrupt === undefined) throw new Error("No SIGINT handler is registered");
    interrupt("SIGINT" as never);
    expect(child.killed).toEqual(["SIGINT"]);
    child.emit("close", null, "SIGINT");
    await expect(running).resolves.toBe(130);
    expect(bridge).toEqual({ opened: 1, closed: 1 });
  });

  it("leaves a terminal's Ctrl-C to psql, which shares the foreground group, and only keeps this process alive", async () => {
    setTerminal(true);
    try {
      const { running } = await launch();
      const keepAlive = process.listeners("SIGINT").at(-1);
      if (keepAlive === undefined) throw new Error("No SIGINT handler is registered");
      keepAlive("SIGINT" as never);
      expect(child.killed).toEqual([]);
      child.emit("close", null, "SIGINT");
      await expect(running).resolves.toBe(130);
      expect(bridge).toEqual({ opened: 1, closed: 1 });
    } finally {
      setTerminal(false);
    }
  });

  it("ends psql the same way when the terminal hangs up", async () => {
    const { running } = await launch();
    const hangup = process.listeners("SIGHUP").at(-1);
    if (hangup === undefined) throw new Error("No SIGHUP handler is registered");
    hangup("SIGHUP" as never);
    expect(child.killed).toEqual(["SIGTERM"]);
    child.emit("close", null, "SIGTERM");
    await expect(running).resolves.toBe(130);
    expect(bridge).toEqual({ opened: 1, closed: 1 });
  });

  it("kills psql with SIGKILL when it is still running five seconds after it was asked to stop", async () => {
    vi.useFakeTimers();
    try {
      const { running } = await launch();
      const terminate = process.listeners("SIGTERM").at(-1);
      if (terminate === undefined) throw new Error("No SIGTERM handler is registered");
      terminate("SIGTERM" as never);
      vi.advanceTimersByTime(4_999);
      expect(child.killed).toEqual(["SIGTERM"]);
      vi.advanceTimersByTime(1);
      expect(child.killed).toEqual(["SIGTERM", "SIGKILL"]);
      expect(bridge).toEqual({ opened: 1, closed: 0 });
      child.emit("close", null, "SIGKILL");
      await expect(running).resolves.toBe(130);
      expect(bridge).toEqual({ opened: 1, closed: 1 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not escalate to SIGKILL once psql has ended after SIGTERM", async () => {
    vi.useFakeTimers();
    try {
      const { running } = await launch();
      const terminate = process.listeners("SIGTERM").at(-1);
      if (terminate === undefined) throw new Error("No SIGTERM handler is registered");
      terminate("SIGTERM" as never);
      child.emit("close", null, "SIGTERM");
      await expect(running).resolves.toBe(130);
      vi.advanceTimersByTime(60_000);
      expect(child.killed).toEqual(["SIGTERM"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("refuses a transport that is not the credential's own host before opening anything", async () => {
    await expect(
      runLocalPsql({ ...session(), websocketUrl: "wss://other.example.test/" }),
    ).rejects.toThrow("Invalid PGCF transport");
    expect(bridge).toEqual({ opened: 0, closed: 0 });
    expect(child.calls).toHaveLength(0);
  });

  it("reports the missing psql client as its own failure and passes other errors through", async () => {
    const { running: missing } = await launch();
    const notFound: NodeJS.ErrnoException = new Error("spawn psql ENOENT");
    notFound.code = "ENOENT";
    child.emit("error", notFound);
    await expect(missing).rejects.toBeInstanceOf(PsqlUnavailableError);
    await expect(missing).rejects.toThrow("The local psql client is unavailable");

    const denied: NodeJS.ErrnoException = new Error("spawn psql EACCES");
    denied.code = "EACCES";
    const { running: refused } = await launch();
    child.emit("error", denied);
    await expect(refused).rejects.toBe(denied);
    expect(bridge).toEqual({ opened: 2, closed: 2 });
  });

  it("resolves the exit code psql reports and turns a terminating signal into 130", async () => {
    for (const [code, signalName, expected] of [
      [0, null, 0],
      [3, null, 3],
      [null, "SIGINT", 130],
      [null, "SIGTERM", 130],
      [null, null, 1],
    ] as const) {
      const { running } = await launch();
      child.emit("close", code, signalName);
      await expect(running).resolves.toBe(expected);
    }
    expect(bridge).toEqual({ opened: 5, closed: 5 });
  });
});
