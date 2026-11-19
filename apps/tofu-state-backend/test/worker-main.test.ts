import { expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    constructor(
      protected readonly ctx: unknown,
      protected readonly env: unknown,
    ) {}
  },
}));

import worker, { TofuStateObject } from "../src/worker-main.js";
import type { StateRecord } from "../src/state.js";

it("keeps the Worker auth boundary before one transactional object and its immutable R2 snapshot", async () => {
  let stored: StateRecord | undefined;
  const snapshots = new Map<string, Uint8Array>();
  const ctx = {
    storage: {
      async get() {
        return stored;
      },
      async transaction<T>(
        work: (transaction: {
          get(): Promise<StateRecord | undefined>;
          put(_key: string, value: StateRecord): Promise<void>;
        }) => Promise<T>,
      ): Promise<T> {
        return work({
          async get() {
            return stored;
          },
          async put(_key, value) {
            stored = value;
          },
        });
      },
    },
  };
  const password = "s".repeat(43);
  const hash = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(password)),
  );
  const env = {
    STATE_ORIGIN: "https://dev-state.omh-installation.example.test",
    STATE_PREFIX: "poc-private-fullstack/",
    STATE_PASSWORD_SHA256: [...hash].map((byte) => byte.toString(16).padStart(2, "0")).join(""),
    SNAPSHOTS: {
      async put(key: string, bytes: Uint8Array, options: { onlyIf: { etagDoesNotMatch: string } }) {
        expect(options.onlyIf.etagDoesNotMatch).toBe("*");
        if (snapshots.has(key)) return null;
        snapshots.set(key, Uint8Array.from(bytes));
        return { key };
      },
      async get(key: string) {
        const value = snapshots.get(key);
        return value === undefined
          ? null
          : { arrayBuffer: async () => Uint8Array.from(value).buffer };
      },
    },
    STATES: undefined as unknown as { getByName(name: string): TofuStateObject },
  };
  const object = new TofuStateObject(ctx as never, env as never);
  env.STATES = {
    getByName(name) {
      expect(name).toBe("poc-private-fullstack/aws-build.tfstate");
      return object;
    },
  };
  const endpoint =
    "https://dev-state.omh-installation.example.test/state/poc-private-fullstack/aws-build.tfstate";
  const authorization = `Basic ${btoa(`tofu:${password}`)}`;
  const call = (method: string, body?: string, suffix = "") =>
    worker.fetch(
      new Request(`${endpoint}${suffix}`, {
        method,
        headers: { authorization },
        ...(body === undefined ? {} : { body }),
      }),
      env,
    );
  expect((await object.fetch(new Request(endpoint))).status).toBe(404);
  expect((await call("LOCK", JSON.stringify({ ID: "first" }))).status).toBe(200);
  const state = JSON.stringify({ version: 4, serial: 1, lineage: "one" });
  expect((await call("POST", state, "?ID=first")).status).toBe(200);
  expect(await (await call("GET")).text()).toBe(state);
  expect(stored?.revision).toBe(1);
  expect(snapshots.size).toBe(1);
});
