import { describe, expect, it } from "vitest";

import {
  createTofuStateService,
  parseStateName,
  type StateMetadataStore,
  type StateRecord,
  type StateSnapshotStore,
} from "../src/state.js";

const URL = "https://state.ohmyho.st/state/production/aws-build.tfstate";
const lock = (id: string) => ({ ID: id, Operation: "OperationTypeApply", Who: "operator" });
const state = (serial: number) =>
  JSON.stringify({ version: 4, serial, lineage: "fixed-lineage", outputs: {} });

function fixture() {
  let record: StateRecord = {
    revision: 0,
    snapshotKey: null,
    sha256: null,
    bytes: 0,
    deleted: true,
    lock: null,
  };
  const objects = new Map<string, Uint8Array>();
  let failWrite = false;
  let beforePut: (() => Promise<void>) | null = null;
  const metadata: StateMetadataStore = {
    async read() {
      return record;
    },
    async update(change) {
      const result = change(record);
      record = result.record;
      return result.result;
    },
  };
  const snapshots: StateSnapshotStore = {
    async putIfAbsent(key, bytes) {
      if (failWrite) throw new Error("R2 unavailable");
      const pending = beforePut;
      beforePut = null;
      await pending?.();
      if (objects.has(key)) return false;
      objects.set(key, Uint8Array.from(bytes));
      return true;
    },
    async read(key) {
      const value = objects.get(key);
      return value === undefined ? null : Uint8Array.from(value);
    },
  };
  return {
    service: createTofuStateService({
      name: "production/aws-build.tfstate",
      metadata,
      snapshots,
      crypto,
    }),
    objects,
    setFailWrite(value: boolean) {
      failWrite = value;
    },
    setBeforePut(work: () => Promise<void>) {
      beforePut = work;
    },
    replaceLock(id: string) {
      record = { ...record, lock: { id, info: lock(id) } };
    },
    get record() {
      return record;
    },
  };
}

function request(method: string, body?: string, id?: string) {
  return new Request(id ? `${URL}?ID=${id}` : URL, {
    method,
    ...(body === undefined ? {} : { body }),
  });
}

describe("private OpenTofu HTTP state", () => {
  it("treats a not-yet-created object as absent without creating a state snapshot", async () => {
    const service = createTofuStateService({
      name: "production/new.tfstate",
      crypto,
      metadata: {
        async read() {
          return null;
        },
        async update() {
          throw new Error("A GET must not write metadata");
        },
      },
      snapshots: {
        async putIfAbsent() {
          throw new Error("A GET must not write R2");
        },
        async read() {
          throw new Error("A GET of absent state must not read R2");
        },
      },
    });
    expect((await service.fetch(request("GET"))).status).toBe(404);
  });

  it("requires an exact lock, stores verified immutable revisions and recovers the latest state", async () => {
    const f = fixture();
    expect((await f.service.fetch(request("GET"))).status).toBe(404);
    expect((await f.service.fetch(request("POST", state(1), "first"))).status).toBe(409);
    expect((await f.service.fetch(request("LOCK", JSON.stringify(lock("first"))))).status).toBe(
      200,
    );
    const collision = await f.service.fetch(request("LOCK", JSON.stringify(lock("second"))));
    expect(collision.status).toBe(423);
    expect(await collision.json()).toMatchObject({ ID: "first" });
    expect((await f.service.fetch(request("POST", state(1), "other"))).status).toBe(409);
    expect((await f.service.fetch(request("POST", state(1), "first"))).status).toBe(200);
    expect(await (await f.service.fetch(request("GET"))).text()).toBe(state(1));
    expect((await f.service.fetch(request("POST", state(1), "first"))).status).toBe(200);
    expect(f.objects.size).toBe(1);
    expect(f.record.revision).toBe(1);
    expect((await f.service.fetch(request("UNLOCK", JSON.stringify(lock("first"))))).status).toBe(
      200,
    );
    expect((await f.service.fetch(request("LOCK", JSON.stringify(lock("second"))))).status).toBe(
      200,
    );
    expect((await f.service.fetch(request("POST", state(2), "second"))).status).toBe(200);
    expect(await (await f.service.fetch(request("GET"))).text()).toBe(state(2));
    expect(f.objects.size).toBe(2);
    expect(f.record.revision).toBe(2);
  });

  it("preserves the previous revision on failed storage and keeps snapshots after a locked delete", async () => {
    const f = fixture();
    await f.service.fetch(request("LOCK", JSON.stringify(lock("first"))));
    await f.service.fetch(request("POST", state(1), "first"));
    f.setFailWrite(true);
    expect((await f.service.fetch(request("POST", state(2), "first"))).status).toBe(503);
    expect(await (await f.service.fetch(request("GET"))).text()).toBe(state(1));
    expect(f.record.revision).toBe(1);
    expect((await f.service.fetch(request("DELETE", undefined, "wrong"))).status).toBe(409);
    expect((await f.service.fetch(request("DELETE", undefined, "first"))).status).toBe(200);
    expect((await f.service.fetch(request("GET"))).status).toBe(404);
    expect(f.objects.size).toBe(1);
    expect((await f.service.fetch(request("UNLOCK", JSON.stringify(lock("wrong"))))).status).toBe(
      409,
    );
    expect((await f.service.fetch(request("UNLOCK", JSON.stringify(lock("first"))))).status).toBe(
      200,
    );
  });

  it("repairs a missing current snapshot from a locked state push without losing the old receipt", async () => {
    const f = fixture();
    await f.service.fetch(request("LOCK", JSON.stringify(lock("first"))));
    await f.service.fetch(request("POST", state(1), "first"));
    const missing = f.record.snapshotKey;
    if (missing === null) throw new Error("Expected first snapshot");
    f.objects.delete(missing);
    expect((await f.service.fetch(request("GET"))).status).toBe(503);
    expect((await f.service.fetch(request("POST", state(1), "first"))).status).toBe(200);
    expect(f.record.revision).toBe(2);
    expect(f.record.snapshotKey).not.toBe(missing);
    expect(await (await f.service.fetch(request("GET"))).text()).toBe(state(1));
  });

  it("does not advance the pointer when a lock is replaced while R2 stores a candidate", async () => {
    const f = fixture();
    await f.service.fetch(request("LOCK", JSON.stringify(lock("first"))));
    await f.service.fetch(request("POST", state(1), "first"));
    f.setBeforePut(async () => f.replaceLock("second"));
    expect((await f.service.fetch(request("POST", state(2), "first"))).status).toBe(409);
    expect(f.record.revision).toBe(1);
    expect(f.record.lock?.id).toBe("second");
    expect(await (await f.service.fetch(request("GET"))).text()).toBe(state(1));
    expect(f.objects.size).toBe(2);
  });

  it("rejects unsafe state names, malformed locks and non-state payloads", async () => {
    expect(() => parseStateName("../customer.tfstate")).toThrow();
    expect(() => parseStateName("production//state.tfstate")).toThrow();
    const f = fixture();
    expect((await f.service.fetch(request("LOCK", JSON.stringify({ ID: "bad id" })))).status).toBe(
      400,
    );
    await f.service.fetch(request("LOCK", JSON.stringify(lock("first"))));
    expect((await f.service.fetch(request("POST", "not-json", "first"))).status).toBe(400);
    expect(f.objects.size).toBe(0);
  });
});
