import { expect, it, vi } from "vitest";

const observed = vi.hoisted(() => ({
  starts: [] as unknown[],
  destroys: 0,
  events: [] as string[],
  startGate: undefined as Promise<void> | undefined,
  failNextStart: false,
  outbound: [] as unknown[],
}));

vi.mock("cloudflare:workers", () => ({
  WorkerEntrypoint: class {
    protected readonly env: unknown;
    constructor(_context: unknown, env: unknown) {
      this.env = env;
    }
  },
  DurableObject: class {
    protected readonly env: unknown;
    protected readonly ctx: unknown;
    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

vi.mock("@cloudflare/containers", () => ({
  Container: class {
    protected readonly env: unknown;
    protected readonly ctx: { container: { running: boolean; agentToken?: string } };
    constructor(ctx: { container: { running: boolean } }, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
    async startAndWaitForPorts(options: {
      startOptions: { envVars: { RECOVERY_AGENT_TOKEN: string } };
    }) {
      observed.starts.push(options);
      observed.events.push("start");
      await observed.startGate;
      this.ctx.container.running = true;
      if (observed.failNextStart) {
        observed.failNextStart = false;
        throw new Error("container_start_failed");
      }
      this.ctx.container.agentToken = options.startOptions.envVars.RECOVERY_AGENT_TOKEN;
    }
    async setOutboundByHost(host: string, handler: string, params: unknown) {
      observed.outbound.push({ host, handler, params });
    }
    async removeOutboundByHost(host: string) {
      observed.outbound.push({ removed: host });
    }
    async destroy() {
      observed.destroys++;
      observed.events.push("destroy");
      this.ctx.container.running = false;
      delete this.ctx.container.agentToken;
    }
  },
}));

import worker, {
  controlDependencies,
  RecoveryContainerService,
  RecoverySandbox,
} from "../src/worker-main.js";

const run = {
  action: "run",
  organizationId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  projectId: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
  operationId: "01ARZ3NDEKTSV4RRFFQ69G5FAX",
  claimId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
};

/** The download reuse window reads this clock; a test moves it instead of waiting. */
class ClockedRecoverySandbox extends RecoverySandbox {
  public clock = { ms: 0 };
  protected override clockMs(): number {
    return this.clock.ms;
  }
}

it("reads the wall clock for the download reuse window unless a test replaces it", () => {
  const sandbox = Object.create(RecoverySandbox.prototype) as { clockMs(): number };
  expect(Math.abs(sandbox.clockMs() - Date.now())).toBeLessThan(1000);
});

it("routes restore policy and sanitization to their distinct regional private entrypoints", async () => {
  const policy = vi.fn(async () => ({ status: "applied" }));
  const sanitize = vi.fn(async () => ({ status: "sanitized" }));
  const dependencies = controlDependencies({
    RECOVERY_CONTROL_STORE: {},
    NATIVE_RESTORE_JOB_STORE: {},
    NATIVE_RESTORE_POLICY_EU: { applyRealmPolicy: policy },
    NATIVE_RESTORE_PREPARATION_EU: { prepare: async () => ({ status: "verified" }) },
    NATIVE_RESTORE_ADMIN_EU: { sanitizeRestore: sanitize },
  } as never);
  const regional = dependencies?.restore?.admin("eu-dev");
  expect(regional).toBeDefined();
  await regional?.applyRealmPolicy({} as never);
  await regional?.sanitizeRestore({} as never);
  await expect(dependencies?.restore?.preparation("eu-dev").prepare({} as never)).resolves.toEqual({
    status: "verified",
  });
  expect(() => dependencies?.restore?.preparation("us-dev")).toThrow("native_restore_unavailable");
  expect(policy).toHaveBeenCalledOnce();
  expect(sanitize).toHaveBeenCalledOnce();
  expect(() => dependencies?.restore?.admin("us-dev")).toThrow("native_restore_unavailable");
});

it("drains the restore sandbox before observing the exact Core request", async () => {
  observed.events.length = 0;
  const request = {
    organizationId: run.organizationId,
    projectId: run.projectId,
    restoreId: run.operationId,
  };
  const observe = vi.fn(async (value: unknown) => {
    expect(value).toEqual(request);
    observed.events.push("observe");
    return { status: "unknown" };
  });
  const sandbox = new RecoverySandbox(
    { container: { running: true } } as never,
    {
      NATIVE_RESTORE_JOB_STORE: { observe },
    } as never,
  );
  await expect(sandbox.observeNativeRestore(request)).resolves.toEqual({ status: "unknown" });
  expect(observe).toHaveBeenCalledTimes(2);
  expect(observed.events).toEqual(["observe", "destroy", "observe"]);
});

it("does not stop a restore container when scoped observation is unauthorized", async () => {
  observed.events.length = 0;
  const sandbox = new RecoverySandbox(
    { container: { running: true } } as never,
    {
      NATIVE_RESTORE_JOB_STORE: {
        observe: async () => {
          throw new Error("unauthorized");
        },
      },
    } as never,
  );
  await expect(sandbox.observeNativeRestore({})).rejects.toThrow("unauthorized");
  expect(observed.events).toEqual([]);
});

it("isolates restore sandbox names by organization and project as well as restore", async () => {
  const request = {
    organizationId: run.organizationId,
    projectId: run.projectId,
    restoreId: run.operationId,
  };
  const service = new RecoveryContainerService(
    {} as never,
    {
      RECOVERY_SANDBOX: {
        getByName(name: string) {
          expect(name).toBe(
            `native-restore/${request.organizationId}/${request.projectId}/${request.restoreId}`,
          );
          return {
            observeNativeRestore: async (value: unknown) => value,
            invoke: async (value: unknown) => value,
          };
        },
      },
    } as never,
  );
  await expect(service.observeNativeRestore(request)).resolves.toEqual(request);
  await expect(
    service.reconcileNativeRestorePin({ ...request, principalId: "owner-fixture" }),
  ).resolves.toEqual({ action: "reconcile-restore-pin", ...request, principalId: "owner-fixture" });
});

it("accepts the private configuration with or without the PGCF key's expiry and refuses a malformed one", () => {
  const configuration = {
    inputKeyBase64: Buffer.alloc(32, 7).toString("base64"),
    r2AccountId: "00000000000000000000000000000001",
    r2AccessKeyId: "a".repeat(32),
    r2ApiToken: "r".repeat(32),
    pgcf: {
      baseUrl: "https://api.pgcf.example.test/",
      projectId: `prj_${"b".repeat(20)}`,
      apiKey: "k".repeat(32),
    },
  };
  const bindings = (value: Record<string, unknown>) => ({
    RESOURCE_NAMESPACE: "production",
    RECOVERY_CONFIGURATION: JSON.stringify(value),
    RECOVERY_SANDBOX: {},
    RECOVERY_CONTROL_STORE: {},
    NATIVE_RESTORE_JOB_STORE: {},
    NATIVE_RESTORE_ADMIN_US: {},
    NATIVE_RESTORE_ADMIN_EU: {},
    NATIVE_RESTORE_POLICY_US: {},
    NATIVE_RESTORE_POLICY_EU: {},
    NATIVE_RESTORE_PREPARATION_US: {},
    NATIVE_RESTORE_PREPARATION_EU: {},
  });
  // Deployed configurations predate the expiry and stay valid.
  expect(
    new RecoveryContainerService(
      {} as never,
      bindings(configuration) as never,
    ).inspectNativeRestore(),
  ).toEqual({ status: "ready", namespace: "production" });
  expect(
    new RecoveryContainerService(
      {} as never,
      bindings({ ...configuration, pgcfKeyExpiresAt: "2099-01-01T00:00:00.000Z" }) as never,
    ).inspectNativeRestore(),
  ).toEqual({ status: "ready", namespace: "production" });
  expect(() =>
    new RecoveryContainerService(
      {} as never,
      bindings({ ...configuration, pgcfKeyExpiresAt: "soon" }) as never,
    ).inspectNativeRestore(),
  ).toThrow("native_restore_unavailable");
});

it("fails restore readiness when private configuration is malformed", () => {
  const bindings = {
    RESOURCE_NAMESPACE: "production",
    RECOVERY_CONFIGURATION: "{}",
    RECOVERY_SANDBOX: {},
    RECOVERY_CONTROL_STORE: {},
    NATIVE_RESTORE_JOB_STORE: {},
    NATIVE_RESTORE_ADMIN_US: {},
    NATIVE_RESTORE_ADMIN_EU: {},
    NATIVE_RESTORE_POLICY_US: {},
    NATIVE_RESTORE_POLICY_EU: {},
    NATIVE_RESTORE_PREPARATION_US: {},
    NATIVE_RESTORE_PREPARATION_EU: {},
  };
  const service = new RecoveryContainerService({} as never, bindings as never);
  expect(() => service.inspectNativeRestore()).toThrow("native_restore_unavailable");
});

it("keeps HTTP private and routes only the closed Recovery RPC to its operation object", async () => {
  expect(worker.fetch().status).toBe(404);
  const requests: unknown[] = [];
  const service = new RecoveryContainerService(
    {} as never,
    {
      RECOVERY_SANDBOX: {
        getByName(name: string) {
          expect(name).toBe(`export/${run.organizationId}/${run.projectId}/${run.operationId}`);
          return {
            async invoke(value: unknown) {
              requests.push(value);
              return { status: "succeeded" };
            },
          };
        },
      },
    } as never,
  );
  await expect(service.invokeRecovery({ ...run, password: "secret" })).rejects.toThrow(
    "RECOVERY_EVENT_INVALID",
  );
  await expect(service.invokeRecovery(run)).resolves.toEqual({ status: "succeeded" });
  expect(requests).toEqual([run]);
});

it("starts one secret-free image per operation with a private token and destroys it after a terminal result", async () => {
  observed.starts.length = 0;
  observed.destroys = 0;
  const state = new Map<string, string>();
  const storageCalls: unknown[][] = [];
  let response: unknown = { status: "succeeded" };
  observed.outbound.length = 0;
  const context = {
    id: { toString: () => "do-1" },
    storage: {
      async get(key: string) {
        storageCalls.push(["get", key]);
        return state.get(key);
      },
      async put(key: string, value: string) {
        storageCalls.push(["put", key]);
        state.set(key, value);
      },
      async delete(key: string) {
        storageCalls.push(["delete", key]);
        return state.delete(key);
      },
    },
    container: {
      running: false,
      getTcpPort(port: number) {
        expect(port).toBe(8080);
        return {
          async fetch(_url: string, init: RequestInit) {
            expect(init.method).toBe("POST");
            const token = String((init.headers as Record<string, string>)["authorization"]).slice(
              7,
            );
            expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/u);
            expect(JSON.parse(String(init.body))).toEqual(run);
            return Response.json(response);
          },
        };
      },
    },
  };
  const sandbox = new RecoverySandbox(
    context as never,
    {
      RESOURCE_NAMESPACE: "production",
      RECOVERY_CONFIGURATION: "private-recovery-config",
    } as never,
  );
  await expect(sandbox.invoke(run)).resolves.toEqual({ status: "succeeded" });
  expect(observed.starts).toHaveLength(1);
  expect(observed.starts[0]).toMatchObject({
    ports: [8080],
    startOptions: {
      envVars: {
        RESOURCE_NAMESPACE: "production",
        RECOVERY_CONFIGURATION: "private-recovery-config",
      },
    },
  });
  expect(observed.destroys).toBe(1);
  expect(state.size).toBe(0);
  // The agent token lives only in the Container's memory: Durable Object storage never sees it or any key for it.
  expect(storageCalls).toEqual([]);
  // The job grant binds this object, this command and the digest of the token that only the Container holds.
  const started = observed.starts[0] as {
    startOptions: { envVars: { RECOVERY_CONTROL_TOKEN: string; RECOVERY_AGENT_TOKEN: string } };
  };
  const controlToken = started.startOptions.envVars.RECOVERY_CONTROL_TOKEN;
  expect(controlToken).toMatch(/^[A-Za-z0-9_-]{43}$/u);
  expect(controlToken).not.toBe(started.startOptions.envVars.RECOVERY_AGENT_TOKEN);
  const digest = Buffer.from(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(controlToken)),
  ).toString("hex");
  expect(observed.outbound).toEqual([
    {
      host: "recovery-control.internal",
      handler: "control",
      params: {
        containerId: "do-1",
        action: "run",
        organizationId: run.organizationId,
        projectId: run.projectId,
        operationId: run.operationId,
        claimId: run.claimId,
        tokenSha256: digest,
        expiresAtMs: expect.any(Number),
      },
    },
    { removed: "recovery-control.internal" },
  ]);
  expect(JSON.stringify(observed.outbound)).not.toContain(controlToken);
  response = { status: "failed", password: "must-not-cross" };
  await expect(sandbox.invoke(run)).rejects.toThrow("recovery_container_response_invalid");
  expect(observed.destroys).toBe(2);
  expect(storageCalls).toEqual([]);
  await sandbox.onActivityExpired();
  expect(observed.destroys).toBeGreaterThanOrEqual(2);
});

it("runs one operation's overlapping calls one at a time and never lets a failed start block the next", async () => {
  observed.events.length = 0;
  const sandboxFor = (operationId: string) => {
    const state = new Map<string, string>();
    const container = {
      running: false,
      agentToken: undefined as string | undefined,
      getTcpPort: () => ({
        async fetch(_url: string, init: RequestInit) {
          observed.events.push(`fetch:${operationId}`);
          // Like the real agent, a Container answers only the token it was started with.
          const token = String((init.headers as Record<string, string>)["authorization"]).slice(7);
          if (!container.running || token !== container.agentToken)
            return new Response(null, { status: 401 });
          return Response.json({
            status: "ready",
            operationId,
            url: "https://exports.example/signed",
            sha256: "a".repeat(64),
            bytes: 128,
            sqlFiles: ["dump.sql"],
            capturedAt: "2026-09-24T00:00:00.000Z",
            archiveExpiresAt: "2026-09-25T00:00:00.000Z",
            downloadExpiresAt: "2026-09-25T00:00:00.000Z",
          });
        },
      }),
    };
    const storage = {
      get: async (key: string) => state.get(key),
      put: async (key: string, value: string) => void state.set(key, value),
      delete: async (key: string) => state.delete(key),
    };
    const sandbox = new ClockedRecoverySandbox(
      { id: { toString: () => `do-${operationId}` }, storage, container } as never,
      {
        RESOURCE_NAMESPACE: "production",
        RECOVERY_CONFIGURATION: "private-recovery-config",
      } as never,
    );
    const command = {
      action: "download",
      organizationId: run.organizationId,
      projectId: run.projectId,
      operationId,
    };
    return { download: () => sandbox.invoke(command), state, sandbox };
  };
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  let openStart: () => void = () => undefined;
  const holdStarts = () => {
    observed.startGate = new Promise((resolve) => {
      openStart = () => {
        observed.startGate = undefined;
        resolve();
      };
    });
  };
  const operation = sandboxFor(run.operationId);
  const ready = { status: "ready" };

  // Two cold-start downloads of one ready export: the second waits for the first to finish and is then
  // answered from the first result, so only one Container boots.
  holdStarts();
  const downloads = [operation.download(), operation.download()];
  await settle();
  // Starting also digests the job token (an asynchronous crypto call), so the first start is awaited, not assumed.
  await vi.waitFor(() => expect(observed.events).toEqual(["start"]));
  openStart();
  await expect(Promise.all(downloads)).resolves.toMatchObject([ready, ready]);
  const fetched = `fetch:${run.operationId}`;
  expect(observed.events).toEqual(["start", fetched, "destroy"]);
  expect(operation.state.size).toBe(0);

  // A start that fails half way is destroyed by that call itself, and a call queued behind a
  // failed one still succeeds afterwards. Both boot again only after the reuse window has passed.
  operation.sandbox.clock.ms += 21_000;
  observed.events.length = 0;
  observed.failNextStart = true;
  await expect(operation.download()).rejects.toThrow("container_start_failed");
  expect(observed.events).toEqual(["start", "destroy"]);
  observed.events.length = 0;
  observed.failNextStart = true;
  const failing = operation.download();
  const following = operation.download();
  await expect(failing).rejects.toThrow("container_start_failed");
  await expect(following).resolves.toMatchObject(ready);
  expect(observed.events).toEqual(["start", "destroy", "start", fetched, "destroy"]);
  expect(operation.state.size).toBe(0);

  // Separate operations own separate objects and never wait for each other.
  observed.events.length = 0;
  const other = sandboxFor("01ARZ3NDEKTSV4RRFFQ69G5FAY");
  operation.sandbox.clock.ms += 21_000;
  holdStarts();
  const parallel = [operation.download(), other.download()];
  await settle();
  await vi.waitFor(() => expect(observed.events).toEqual(["start", "start"]));
  openStart();
  await expect(Promise.all(parallel)).resolves.toMatchObject([
    { ...ready, operationId: run.operationId },
    { ...ready, operationId: "01ARZ3NDEKTSV4RRFFQ69G5FAY" },
  ]);
});

function downloadSandbox(
  operationId: string,
  answer: (command: Record<string, unknown>) => unknown,
) {
  const container = {
    running: false,
    getTcpPort: () => ({
      async fetch(_url: string, init: RequestInit) {
        return Response.json(answer(JSON.parse(String(init.body))));
      },
    }),
  };
  return new ClockedRecoverySandbox(
    { id: { toString: () => `do-${operationId}` }, container } as never,
    {
      RESOURCE_NAMESPACE: "production",
      RECOVERY_CONFIGURATION: "private-recovery-config",
    } as never,
  );
}

function readyExport(operationId: string) {
  return {
    status: "ready",
    operationId,
    url: "https://exports.example/signed",
    sha256: "a".repeat(64),
    bytes: 128,
    sqlFiles: ["dump.sql"],
    capturedAt: "2026-09-24T00:00:00.000Z",
    archiveExpiresAt: "2026-09-25T00:00:00.000Z",
    downloadExpiresAt: "2026-09-25T00:00:00.000Z",
  };
}

const downloadCommand = {
  action: "download",
  organizationId: run.organizationId,
  projectId: run.projectId,
  operationId: run.operationId,
};

it("answers a repeated download of one ready export from memory for 20 seconds per operation", async () => {
  observed.starts.length = 0;
  const sandbox = downloadSandbox(run.operationId, () => readyExport(run.operationId));
  const first = await sandbox.invoke(downloadCommand);
  expect(observed.starts).toHaveLength(1);
  sandbox.clock.ms = 19_999;
  await expect(sandbox.invoke(downloadCommand)).resolves.toEqual(first);
  expect(observed.starts).toHaveLength(1);
  // Another operation owns another object, so it boots its own Container and is never answered from this one.
  const otherOperationId = "01ARZ3NDEKTSV4RRFFQ69G5FAY";
  const other = downloadSandbox(otherOperationId, () => readyExport(otherOperationId));
  await other.invoke({ ...downloadCommand, operationId: otherOperationId });
  expect(observed.starts).toHaveLength(2);
  // Twenty-one seconds after the first answer, the object boots its Container again.
  sandbox.clock.ms = 21_000;
  await sandbox.invoke(downloadCommand);
  expect(observed.starts).toHaveLength(3);
});

it("drops the remembered download when a run or purge reaches the same operation", async () => {
  observed.starts.length = 0;
  const sandbox = downloadSandbox(run.operationId, (command) => {
    if (command["action"] === "run") return { status: "succeeded" };
    if (command["action"] === "purge") return { exportId: run.operationId, status: "absent" };
    return readyExport(run.operationId);
  });
  await sandbox.invoke(downloadCommand);
  expect(observed.starts).toHaveLength(1);
  await sandbox.invoke(run);
  expect(observed.starts).toHaveLength(2);
  await sandbox.invoke(downloadCommand);
  expect(observed.starts).toHaveLength(3);
  await sandbox.invoke({ ...downloadCommand, action: "purge", exportId: run.operationId });
  expect(observed.starts).toHaveLength(4);
  await sandbox.invoke(downloadCommand);
  expect(observed.starts).toHaveLength(5);
});

it("does not stop an already running executor when a new invocation has no current proof", async () => {
  observed.destroys = 0;
  const sandbox = new RecoverySandbox(
    { id: { toString: () => "do-busy" }, container: { running: true } } as never,
    {
      RESOURCE_NAMESPACE: "production",
      RECOVERY_CONFIGURATION: "private-recovery-config",
    } as never,
  );
  await expect(
    sandbox.invoke({ ...run, claimId: "00000000-0000-4000-8000-000000000099" }),
  ).rejects.toThrow("recovery_container_busy");
  expect(observed.destroys).toBe(0);
});

it("seals restore input, authorizes its exact scope, and admits the claim before starting the container", async () => {
  const { createRecoveryInputCipher } = await import("@ohmyhost/platform");
  const inputKey = new Uint8Array(32).fill(7);
  const scope = {
    organizationId: run.organizationId,
    projectId: run.projectId,
    restoreId: run.operationId,
  };
  const order: string[] = [];
  let captured: Record<string, unknown> | undefined;
  const restoreStore = {
    authorizeAdmission: async (input: Record<string, unknown>) => {
      order.push("authorize");
      expect(input).toMatchObject({
        ...scope,
        proposedClaimId: run.claimId,
        principalId: "user_owner",
        archiveSha256: "ab".repeat(32),
      });
      return { authorized: true };
    },
    accept: async (input: Record<string, unknown>) => {
      order.push("accept");
      captured = input;
      return { status: "accepted" };
    },
    claim: async (input: unknown) => {
      order.push("claim");
      expect(input).toEqual({ ...scope, claimId: run.claimId });
      return { status: "claimed" };
    },
  };
  const context = {
    id: { toString: () => "restore-sandbox" },
    container: {
      running: false,
      getTcpPort: () => ({
        fetch: async (_: unknown, request: RequestInit) => {
          order.push("invoke");
          expect(JSON.parse(String(request.body))).toEqual({
            action: "restore",
            ...scope,
            claimId: run.claimId,
          });
          return Response.json({ status: "complete", restoreId: scope.restoreId });
        },
      }),
    },
  };
  const bindings = {
    RESOURCE_NAMESPACE: "production",
    RECOVERY_CONFIGURATION: JSON.stringify({
      inputKeyBase64: Buffer.from(inputKey).toString("base64"),
    }),
    NATIVE_RESTORE_JOB_STORE: restoreStore,
  };
  const sandbox = new RecoverySandbox(context as never, bindings as never);
  // Rejected admission and resume leave the serialized sandbox usable for the valid owner.
  await expect(sandbox.admitNativeRestore({ command: {}, admission: {} })).rejects.toThrow();
  await expect(sandbox.resumeNativeRestore({ action: "run" })).rejects.toThrow();
  const service = new RecoveryContainerService(
    {} as never,
    {
      ...bindings,
      RECOVERY_SANDBOX: {
        getByName: (name: string) => {
          expect(name).toBe(
            `native-restore/${scope.organizationId}/${scope.projectId}/${scope.restoreId}`,
          );
          return sandbox;
        },
      },
    } as never,
  );
  await expect(
    service.invokeNativeRestore({
      ...scope,
      claimId: run.claimId,
      principalId: "user_owner",
      exportOperationId: "01ARZ3NDEKTSV4RRFFQ69G5FAY",
      archiveSha256: "ab".repeat(32),
      passphrase: "fixture-passphrase",
    }),
  ).resolves.toEqual({ status: "complete", restoreId: scope.restoreId });
  expect(order).toEqual(["authorize", "accept", "claim", "invoke"]);
  expect(captured).toBeDefined();
  expect(JSON.stringify(captured)).not.toContain("fixture-passphrase");
  const sealedInput = captured?.["sealedInput"] as {
    ciphertext: Uint8Array;
    nonce: Uint8Array;
    keyVersion: number;
  };
  const plaintext = await createRecoveryInputCipher({ key: inputKey, keyVersion: 1, crypto }).open(
    { ...scope, operationId: scope.restoreId },
    sealedInput,
  );
  expect(JSON.parse(new TextDecoder().decode(plaintext))).toEqual({
    version: 1,
    passphrase: "fixture-passphrase",
  });
  plaintext.fill(0);
});
