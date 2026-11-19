import { expect, it } from "vitest";
import { PreviewBackups } from "../src/backup.js";
import { PreviewSessionController, type PreviewSessionPorts } from "../src/session.js";

it("applies an accepted intermediate save before diffing a newer save without stopping the VM", async () => {
  const id = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
  const version = (sequence: number) => ({
    sourceConnectionId: id,
    sourceGeneration: 1,
    sequence,
    commitSha: String(sequence).repeat(40),
  });
  const fence = { previewId: id, runtimeGeneration: 2, tokenGeneration: 1 };
  const plan = { adapter: "vite-static", runtimePolicy: { egressAllowedOrigins: [] } };
  const entries = new Map<string, unknown>();
  const storage = {
    async get<T>(key: string) {
      return entries.get(key) as T | undefined;
    },
    async put<T>(key: string, value: T) {
      entries.set(key, structuredClone(value));
    },
    async setAlarm() {},
    async getAlarm() {
      return null;
    },
    async deleteAlarm() {},
  };
  await storage.put("product-session-v1", {
    state: "ready",
    phase: "ready",
    failure: null,
    failedAt: null,
    fence,
    applied: version(1),
    plan,
    planHash: "same-plan",
    region: "us",
    lastActivityAt: 1,
  });
  let record = {
    ...fence,
    state: "ready",
    retirement: "none",
    targetSource: version(2),
    appliedSource: version(1),
    rowVersion: 1,
    lastActivityAt: new Date(1).toISOString(),
  };
  const written: string[] = [];
  let stopped = false;
  const core = {
    async authorizeRuntime() {
      return record;
    },
    async recordAppliedSource(input: { source: ReturnType<typeof version> }) {
      record = { ...record, appliedSource: input.source, rowVersion: record.rowVersion + 1 };
      return record;
    },
    async renewActivity(input: { occurredAt: string }) {
      record = { ...record, lastActivityAt: input.occurredAt, rowVersion: record.rowVersion + 1 };
      return record;
    },
  };
  const source = {
    async previewDiff(input: { from: ReturnType<typeof version>; to: ReturnType<typeof version> }) {
      return {
        from: input.from,
        to: input.to,
        operations: [{ kind: "delete", path: `src/${input.to.sequence}.txt` }],
        dependenciesChanged: false,
        inspection: { frameworkPlan: plan, buildPlanSha256: "same-plan" },
        install: null,
      };
    },
  };
  const driver = {
    running: () => true,
    writer: {
      async apply(operations: readonly { path: string }[]) {
        const [operation] = operations;
        if (!operation) throw new Error("missing source operation");
        written.push(operation.path);
        if (written.length === 1)
          record = { ...record, targetSource: version(3), rowVersion: record.rowVersion + 1 };
      },
    },
    async ensurePrepared() {},
    async updateSource() {},
    async destroy() {
      stopped = true;
    },
  };
  const backups = new PreviewBackups(storage, {
    async backup() {
      throw new Error("unused");
    },
    async restore() {},
    async delete() {},
  });
  const controller = new PreviewSessionController({
    core,
    source,
    storage,
    driver,
    backups,
    reconcileBackup: async () => {},
    now: () => 10,
    waitUntil: () => {},
  } as unknown as PreviewSessionPorts);
  await controller.rememberOrigin("https://preview.example");
  await controller.synchronize();
  expect(written).toEqual(["src/2.txt", "src/3.txt"]);
  expect((await controller.status()).applied?.sequence).toBe(3);
  expect(stopped).toBe(false);
});
