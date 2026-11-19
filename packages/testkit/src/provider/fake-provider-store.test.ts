import { spawn } from "node:child_process";
import { access, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { afterAll, afterEach, describe, expect, it } from "vitest";

import { FakeProviderStore, type FakeStaticResourceRecord } from "./fake-provider-store.js";

const RECORD: FakeStaticResourceRecord = {
  operationId: "01J00000000000000000000002",
  projectId: "01J00000000000000000000000",
  environmentId: "01J00000000000000000000001",
  idempotencyKey: "deploy-1",
  inputFingerprint: "f".repeat(64),
  resource: {
    capability: "static-hosting",
    provider: "fake-static",
    externalId: "fake-static-123",
    createdAt: new Date("2026-08-17T10:00:00.000Z"),
  },
  observedState: "ready",
};

const SECOND_RECORD: FakeStaticResourceRecord = {
  ...RECORD,
  operationId: "01J00000000000000000000003",
  idempotencyKey: "deploy-2",
  inputFingerprint: "e".repeat(64),
  resource: { ...RECORD.resource, externalId: "fake-static-456" },
};

const activeDirectories: string[] = [];
const createdDirectories: string[] = [];

async function createTemporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  activeDirectories.push(directory);
  createdDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  for (const directory of activeDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

afterAll(async () => {
  for (const directory of createdDirectories) {
    await expect(access(directory)).rejects.toMatchObject({ code: "ENOENT" });
  }
});

describe("FakeProviderStore", () => {
  it("persists records atomically to the injected file and reloads them", async () => {
    const directory = await createTemporaryDirectory("ohmyhost-store-");
    const path = join(directory, "provider-state.json");
    const first = new FakeProviderStore(path);

    await first.put(RECORD);
    const reloaded = await new FakeProviderStore(path).getByMutation(
      "01J00000000000000000000002",
      "deploy-1",
    );

    expect(reloaded).toEqual(RECORD);
    const serialized = await readFile(path, "utf8");
    expect(serialized).toContain('"version": 1');
    expect(serialized).not.toContain(".tmp");
  });

  it("rejects malformed persisted records", async () => {
    const directory = await createTemporaryDirectory("ohmyhost-store-invalid-");
    const path = join(directory, "provider-state.json");
    await writeFile(path, '{"version":1,"resources":[{"idempotencyKey":7}]}', "utf8");

    await expect(new FakeProviderStore(path).list()).rejects.toThrow(
      "Fake provider store contains an invalid record",
    );
  });

  it("keeps fake provider state independent from a simulated control DB rollback", async () => {
    const directory = await createTemporaryDirectory("ohmyhost-store-rollback-");
    const path = join(directory, "provider-state.json");
    const store = new FakeProviderStore(path);
    const simulatedControlDb: FakeStaticResourceRecord[] = [];

    await store.put(RECORD);
    simulatedControlDb.push(RECORD);
    simulatedControlDb.length = 0;

    await expect(
      new FakeProviderStore(path).getByMutation("01J00000000000000000000002", "deploy-1"),
    ).resolves.toEqual(RECORD);
    expect(simulatedControlDb).toEqual([]);
  });

  it("serializes concurrent writes from separate store instances without losing records", async () => {
    const directory = await createTemporaryDirectory("ohmyhost-store-concurrent-");
    const path = join(directory, "provider-state.json");

    await Promise.all([
      new FakeProviderStore(path).put(RECORD),
      new FakeProviderStore(path).put(SECOND_RECORD),
    ]);

    await expect(new FakeProviderStore(path).list()).resolves.toEqual([RECORD, SECOND_RECORD]);
    await expect(readdir(directory)).resolves.toEqual(["provider-state.json"]);
  });

  it("rejects duplicate mutation scopes, duplicate external IDs, and malformed identity fields", async () => {
    const directory = await createTemporaryDirectory("ohmyhost-store-duplicates-");
    const path = join(directory, "provider-state.json");
    const persisted = (records: readonly unknown[]) =>
      JSON.stringify({
        version: 1,
        resources: records.map((record) => {
          const typedRecord = record as FakeStaticResourceRecord;
          return {
            ...typedRecord,
            resource: {
              ...typedRecord.resource,
              createdAt: typedRecord.resource.createdAt.toISOString(),
            },
          };
        }),
      });

    await writeFile(path, persisted([RECORD, { ...RECORD }]), "utf8");
    await expect(new FakeProviderStore(path).list()).rejects.toThrow(
      "duplicate operation and idempotency key",
    );

    await writeFile(
      path,
      persisted([SECOND_RECORD, { ...RECORD, resource: SECOND_RECORD.resource }]),
      "utf8",
    );
    await expect(new FakeProviderStore(path).list()).rejects.toThrow("duplicate external ID");

    await writeFile(path, persisted([{ ...RECORD, idempotencyKey: " deploy-1" }]), "utf8");
    await expect(new FakeProviderStore(path).list()).rejects.toThrow("invalid record");

    await writeFile(
      path,
      persisted([{ ...RECORD, resource: { ...RECORD.resource, provider: "foreign" } }]),
      "utf8",
    );
    await expect(new FakeProviderStore(path).list()).rejects.toThrow("invalid record");
  });

  it("persists simultaneous mutations across repeated cross-process lock handoffs", async () => {
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const directory = await createTemporaryDirectory("ohmyhost-store-processes-");
      const path = join(directory, "provider-state.json");
      const gatePath = join(directory, "start.gate");
      const first = startStoreProcess(path, gatePath, RECORD);
      const second = startStoreProcess(path, gatePath, SECOND_RECORD);

      await Promise.all([first.ready, second.ready]);
      await writeFile(gatePath, "start", "utf8");
      await Promise.all([first.completed, second.completed]);

      await expect(new FakeProviderStore(path).list()).resolves.toEqual([RECORD, SECOND_RECORD]);
      await expect(readdir(directory)).resolves.toEqual(["provider-state.json", "start.gate"]);
    }
  });

  it("recovers an owner-only stale regular lock", async () => {
    const directory = await createTemporaryDirectory("ohmyhost-store-stale-lock-");
    const path = join(directory, "provider-state.json");
    const lockPath = `${path}.lock`;
    await writeFile(
      lockPath,
      JSON.stringify({ pid: 999_999_999, createdAtMs: 0, token: "stale-lock" }),
      { encoding: "utf8", mode: 0o600 },
    );
    const old = new Date("2000-01-01T00:00:00.000Z");
    const { utimes } = await import("node:fs/promises");
    await utimes(lockPath, old, old);

    await new FakeProviderStore(path).put(RECORD);

    await expect(access(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(new FakeProviderStore(path).list()).resolves.toEqual([RECORD]);
  });

  it("rejects a symlink in place of the cross-process lock", async () => {
    const directory = await createTemporaryDirectory("ohmyhost-store-symlink-lock-");
    const path = join(directory, "provider-state.json");
    const target = join(directory, "target");
    await writeFile(target, "do-not-touch", "utf8");
    const { symlink } = await import("node:fs/promises");
    await symlink(target, `${path}.lock`);

    await expect(new FakeProviderStore(path).put(RECORD)).rejects.toThrow(
      "Fake provider lock must be a regular file",
    );
    await expect(readFile(target, "utf8")).resolves.toBe("do-not-touch");
  });
});

interface StoreProcess {
  readonly ready: Promise<void>;
  readonly completed: Promise<void>;
}

function startStoreProcess(
  statePath: string,
  gatePath: string,
  record: FakeStaticResourceRecord,
): StoreProcess {
  const moduleUrl = pathToFileURL(join(import.meta.dirname, "fake-provider-store.ts")).href;
  const script = `
    import { access } from "node:fs/promises";
    import { setTimeout } from "node:timers/promises";
    import { FakeProviderStore } from ${JSON.stringify(moduleUrl)};
    const [statePath, gatePath, serialized] = process.argv.slice(1);
    const parsed = JSON.parse(serialized);
    parsed.resource.createdAt = new Date(parsed.resource.createdAt);
    process.stdout.write("READY\\n");
    while (true) {
      try { await access(gatePath); break; } catch { await setTimeout(2); }
    }
    await new FakeProviderStore(statePath).createOrReplay(parsed);
  `;
  const child = spawn(
    process.execPath,
    [
      "--experimental-strip-types",
      "--input-type=module",
      "--eval",
      script,
      statePath,
      gatePath,
      JSON.stringify(record),
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const ready = new Promise<void>((resolve) => {
    child.stdout.setEncoding("utf8");
    child.stdout.once("data", () => resolve());
  });
  const completed = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Store child exited ${String(code)}: ${stderr}`));
      }
    });
  });
  return { ready, completed };
}
