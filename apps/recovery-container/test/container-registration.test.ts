import { afterEach, expect, it, vi } from "vitest";

/**
 * Only the `cloudflare:workers` base classes are replaced (they exist only inside workerd). The installed
 * `@cloudflare/containers` implementation -- its static handler registry, `setOutboundByHost`, the interception
 * refresh and the `ContainerProxy` that routes an intercepted request to a registered handler -- and the production
 * `RecoverySandbox` and control handler are real.
 */
vi.mock("cloudflare:workers", () => ({
  WorkerEntrypoint: class {
    protected readonly ctx: unknown;
    protected readonly env: unknown;
    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
  DurableObject: class {
    protected readonly ctx: unknown;
    protected readonly env: unknown;
    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

import { Container, ContainerProxy } from "@cloudflare/containers";
import { RECOVERY_CONTROL_HOST } from "@ohmyhost/project-recovery-worker/control-wire";

import { RecoverySandbox } from "../src/worker-main.js";

const run = {
  action: "run",
  organizationId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  projectId: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
  operationId: "01ARZ3NDEKTSV4RRFFQ69G5FAX",
  claimId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
} as const;

interface Intercepted {
  fetch(request: Request): Promise<Response>;
}

/** The Durable Object context the installed library reads: storage kv, the container handle and `ctx.exports`. */
function objectContext(id: string) {
  const kv = new Map<string, unknown>();
  const storage = new Map<string, unknown>();
  const intercepted: { all: Intercepted[]; hosts: Map<string, Intercepted> } = {
    all: [],
    hosts: new Map(),
  };
  const context = {
    id: { toString: () => id },
    storage: {
      kv: {
        get: (key: string) => kv.get(key),
        put: (key: string, value: unknown) => void kv.set(key, structuredClone(value)),
      },
      get: async (key: string) => storage.get(key),
      put: async (key: string, value: unknown) => void storage.set(key, value),
      delete: async (key: string) => storage.delete(key),
      sql: { exec: () => [] },
      sync: async () => undefined,
      setAlarm: async () => undefined,
      deleteAlarm: async () => undefined,
      getAlarm: async () => null,
    },
    blockConcurrencyWhile: (work: () => Promise<void>) => work(),
    container: {
      running: false,
      interceptAllOutboundHttp: async (fetcher: Intercepted) => void intercepted.all.push(fetcher),
      interceptOutboundHttp: async (host: string, fetcher: Intercepted) =>
        void intercepted.hosts.set(host, fetcher),
      getTcpPort: () => ({ fetch: async () => Response.json({ status: "succeeded" }) }),
    },
    exports: {
      // What the runtime hands back for `ctx.exports.ContainerProxy({ props })`: the real proxy over those props.
      ContainerProxy: ({ props }: { props: unknown }) => ({
        fetch: (request: Request) =>
          new (ContainerProxy as unknown as new (ctx: unknown, env: unknown) => Intercepted)(
            { props },
            environment,
          ).fetch(request),
      }),
    },
  };
  return { context, kv, intercepted };
}

const calls: unknown[] = [];
const environment = {
  RESOURCE_NAMESPACE: "production",
  RECOVERY_CONFIGURATION: "private-recovery-config",
  RECOVERY_CONTROL_STORE: {
    readClaimState: async (input: unknown) => (calls.push(input), { status: "running" }),
  },
};

afterEach(() => {
  vi.unstubAllGlobals();
  calls.length = 0;
});

it("registers the control handler through the inherited static setter of the installed Container", () => {
  expect(Object.keys(Container.outboundHandlers ?? {})).not.toContain("control");
  // The registry the proxy and `setOutboundByHost` read holds the handler under this class name.
  expect(Object.keys(RecoverySandbox.outboundHandlers ?? {})).toEqual(["control"]);
  // ... as a registration, not as an own static field that would shadow the setter.
  expect(Object.getOwnPropertyDescriptor(RecoverySandbox, "outboundHandlers")).toBeUndefined();
});

it("fails the old static-field registration with the installed library: the handler never reaches the registry", async () => {
  class FieldSandbox extends Container {
    static override outboundHandlers = { control: async () => new Response("never") };
  }
  expect(Object.getOwnPropertyDescriptor(FieldSandbox, "outboundHandlers")?.value).toBeDefined();
  const { context } = objectContext("do-field");
  const instance = new FieldSandbox(context as never, environment as never);
  await expect(
    instance.setOutboundByHost(RECOVERY_CONTROL_HOST, "control", { containerId: "do-field" }),
  ).rejects.toThrow("Outbound handler method 'control' not found in outboundHandlers");
});

it("serves the Container's control host through the installed registry and ContainerProxy, and withdraws the grant", async () => {
  const internet: string[] = [];
  vi.stubGlobal(
    "fetch",
    async (request: Request) => (
      internet.push(new URL(request.url).hostname),
      new Response("internet")
    ),
  );
  const { context, kv, intercepted } = objectContext("do-real");
  const sandbox = new RecoverySandbox(context as never, environment as never);
  let controlToken = "";
  let during: { control: Response; other: Response; wrongToken: Response } | undefined;
  const latest = () => intercepted.all[intercepted.all.length - 1] as Intercepted;
  vi.spyOn(sandbox as never as Container, "startAndWaitForPorts").mockImplementation(
    async (options: unknown) => {
      controlToken = (options as { startOptions: { envVars: Record<string, string> } }).startOptions
        .envVars["RECOVERY_CONTROL_TOKEN"] as string;
      context.container.running = true;
    },
  );
  vi.spyOn(sandbox as never as Container, "destroy").mockImplementation(async () => {
    context.container.running = false;
  });
  context.container.getTcpPort = () => ({
    fetch: async () => {
      const send = (url: string, token: string) =>
        latest().fetch(
          new Request(url, {
            method: "POST",
            headers: { authorization: `Bearer ${token}` },
            body: "{}",
          }),
        );
      during = {
        control: await send(`http://${RECOVERY_CONTROL_HOST}/v1/readClaimState`, controlToken),
        other: await send("http://customer-pgcf.example/query", controlToken),
        wrongToken: await send(`http://${RECOVERY_CONTROL_HOST}/v1/readClaimState`, "x".repeat(43)),
      };
      return Response.json({ status: "succeeded" });
    },
  });

  await expect(sandbox.invoke(run)).resolves.toEqual({ status: "succeeded" });

  // The real proxy handed the request to the real handler with this object's id, class and grant.
  expect(during?.control.status).toBe(200);
  expect(await during?.control.json()).toEqual({ status: "running" });
  expect(calls).toEqual([
    { organizationId: run.organizationId, projectId: run.projectId, operationId: run.operationId },
  ]);
  // The token is bound to the digest in the grant: another token is refused by the handler itself.
  expect(during?.wrongToken.status).toBe(401);
  // Everything else keeps its Internet path; the virtual host never touches it.
  expect(await during?.other.text()).toBe("internet");
  expect(internet).toEqual(["customer-pgcf.example"]);

  // After the call no interception of the control host remains, in the live proxy or in the persisted config.
  internet.length = 0;
  const after = await latest().fetch(
    new Request(`http://${RECOVERY_CONTROL_HOST}/v1/readClaimState`, {
      method: "POST",
      headers: { authorization: `Bearer ${controlToken}` },
      body: "{}",
    }),
  );
  expect(await after.text()).toBe("internet");
  expect(calls).toHaveLength(1);
  const persisted = JSON.stringify([...kv.values()]);
  expect(persisted).not.toContain(RECOVERY_CONTROL_HOST);
  expect(persisted).not.toContain(controlToken);
});

it("withdraws the grant even when destroying the Container fails, and before it", async () => {
  const { context, kv, intercepted } = objectContext("do-destroy");
  const sandbox = new RecoverySandbox(context as never, environment as never);
  const order: string[] = [];
  vi.spyOn(sandbox as never as Container, "startAndWaitForPorts").mockImplementation(async () => {
    context.container.running = true;
  });
  vi.spyOn(sandbox as never as Container, "removeOutboundByHost").mockImplementation(async () => {
    order.push("withdraw");
  });
  vi.spyOn(sandbox as never as Container, "destroy").mockImplementation(async () => {
    order.push("destroy");
    throw new Error("destroy failed");
  });
  await expect(sandbox.invoke(run)).resolves.toEqual({ status: "succeeded" });
  expect(order).toEqual(["withdraw", "destroy"]);
  expect(intercepted.all.length).toBeGreaterThan(0);
  expect([...kv.keys()].length).toBeGreaterThan(0);
});
