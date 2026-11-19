import { beforeEach, describe, expect, it, vi } from "vitest";

const workerState = vi.hoisted(() => ({ env: undefined as unknown }));

/** Only the `cloudflare:workers` base class is replaced; bindings, runtime and persistence port are the production code. */
vi.mock("cloudflare:workers", () => ({
  WorkerEntrypoint: class {
    public readonly env = workerState.env;
  },
}));

const calls: string[] = [];
const core = new Proxy(
  {},
  {
    get: (_target, method) => (): never => {
      calls.push(String(method));
      throw new Error("Core must not be reached");
    },
  },
);

const wfp = () => ({
  stageVerifiedArtifact: vi.fn(),
  prepareExistingCandidate: vi.fn(),
  activateCandidate: vi.fn(),
  compensateGatewayActivation: vi.fn(),
  compensateActivation: vi.fn(),
  removeCandidate: vi.fn(),
  observeActivation: vi.fn(),
  syncRuntimeSecrets: vi.fn(),
});

const bindings = () => ({
  RUNTIME_CONFIGURATION_STATE: "configured",
  RUNTIME_SECRET_RUNTIME: core,
  ENVIRONMENT_SECRET_KEY_BASE64: Buffer.alloc(32, 0x41).toString("base64"),
  ENVIRONMENT_SECRET_ADDITIONAL_KEYS_JSON: JSON.stringify({
    2: Buffer.alloc(32, 0x42).toString("base64"),
  }),
  ENVIRONMENT_SECRET_KEY_VERSION: "2",
  WFP_MANAGEMENT: wfp(),
});

const methods = [
  "stageCandidate",
  "stagePromotionCandidate",
  "recordStagedCandidate",
  "prepareExistingCandidate",
  "activateCandidate",
  "recordActivatedCandidate",
  "observeActivation",
  "compensateActivation",
  "compensateGatewayActivation",
  "removeCandidate",
  "removePersistedCandidate",
  "installPlatformSecret",
  "ensureCustomerAuthSecret",
  "ensureMailGatewayKey",
  "ensureStorageGatewayKey",
  "ensureAiGatewayKey",
  "ensureBrowserGatewayKey",
  "reconcileRuntimeSecrets",
] as const;

describe("runtime secret delivery Worker", () => {
  beforeEach(() => {
    calls.length = 0;
    workerState.env = bindings();
  });

  it("keeps HTTP private and exposes only immutable WFP candidate RPCs", async () => {
    const { RuntimeSecretDeliveryService, default: RuntimeSecretDeliveryWorker } = await import(
      "../src/worker-main.js"
    );
    const worker = new RuntimeSecretDeliveryWorker({} as never, workerState.env as never);
    await expect(worker.fetch()).resolves.toMatchObject({ status: 404 });
    for (const method of methods)
      expect(RuntimeSecretDeliveryService.prototype).toHaveProperty(method);
    for (const method of [
      "publishVerifiedArtifact",
      "promoteVerifiedArtifact",
      "rollbackVerifiedArtifact",
    ])
      expect(RuntimeSecretDeliveryService.prototype).not.toHaveProperty(method);
  });

  it("builds the production runtime from valid bindings: every RPC refuses an invalid input before the Core is reached and the schedule surfaces a Core failure", async () => {
    const { RuntimeSecretDeliveryService, default: RuntimeSecretDeliveryWorker } = await import(
      "../src/worker-main.js"
    );
    const service = new RuntimeSecretDeliveryService({} as never, workerState.env as never);
    for (const method of methods) await expect(service[method]({})).rejects.toThrow();
    expect(calls).toEqual([]);
    const worker = new RuntimeSecretDeliveryWorker({} as never, workerState.env as never);
    await expect(worker.scheduled()).rejects.toThrow("Core must not be reached");
    expect(calls).toEqual(["readPending"]);
  });

  it("rejects widened or incomplete bindings on every RPC and on the schedule", async () => {
    const { RuntimeSecretDeliveryService, default: RuntimeSecretDeliveryWorker } = await import(
      "../src/worker-main.js"
    );
    const invalid = (value: unknown, message: string) => {
      workerState.env = value;
      return {
        service: new RuntimeSecretDeliveryService({} as never, value as never),
        worker: new RuntimeSecretDeliveryWorker({} as never, value as never),
        message,
      };
    };
    const missingCore = { ...bindings() } as Record<string, unknown>;
    Reflect.deleteProperty(missingCore, "RUNTIME_SECRET_RUNTIME");
    const brokenWfp = bindings();
    brokenWfp.WFP_MANAGEMENT = { ...wfp(), observeActivation: undefined as never };
    for (const { service, worker, message } of [
      invalid({ ...bindings(), SOURCE_FETCHER: {} }, "binding inventory is not exact"),
      invalid({ ...bindings(), CONTROL_CORE: {} }, "binding inventory is not exact"),
      invalid(missingCore, "binding inventory is not exact"),
      invalid({ ...bindings(), RUNTIME_SECRET_RUNTIME: {} }, "private Core persistence binding"),
      invalid(brokenWfp, "requires its private WFP management binding"),
    ]) {
      for (const method of methods) await expect(service[method]({})).rejects.toThrow(message);
      await expect(worker.scheduled()).rejects.toThrow(message);
    }
    expect(calls).toEqual([]);
  });
});
