import { describe, expect, it, vi } from "vitest";

const nativeEntries = vi.hoisted(() => new Map<string, string>());
const nativeServices = vi.hoisted(() => new Array<string>());

vi.mock("@napi-rs/keyring", () => ({
  AsyncEntry: class {
    public constructor(
      service: string,
      private readonly account: string,
    ) {
      nativeServices.push(service);
    }

    public async setPassword(password: string): Promise<void> {
      nativeEntries.set(this.account, password);
    }

    public async getPassword(): Promise<string | null> {
      return nativeEntries.get(this.account) ?? null;
    }

    public async deleteCredential(): Promise<boolean> {
      return nativeEntries.delete(this.account);
    }
  },
}));

import {
  CredentialStoreIntegrityError,
  CredentialStoreUnavailableError,
  NativeNapiKeyringCredentialStore,
  type KeyringEntryFactory,
} from "../src/credential-store.js";

const OLD = {
  accessToken: "old-access",
  refreshToken: "old-refresh",
  expiresAt: "2026-08-18T01:00:00.000Z",
};
const NEW = {
  accessToken: "new-access",
  refreshToken: "new-refresh",
  expiresAt: "2026-08-18T02:00:00.000Z",
};

describe("native keyring credential store", () => {
  it("loads the pinned native keyring adapter through the default factory", async () => {
    nativeEntries.clear();
    nativeServices.length = 0;
    const store = new NativeNapiKeyringCredentialStore();

    await expect(store.read()).resolves.toBeUndefined();
    expect(nativeServices).toContain("ohmyhost");
  });

  it("can isolate a native platform proof in a unique service namespace", async () => {
    nativeEntries.clear();
    nativeServices.length = 0;
    const store = new NativeNapiKeyringCredentialStore(undefined, "ohmyhost-proof-safe-id");

    await store.replace(NEW);
    await expect(store.read()).resolves.toEqual(NEW);
    await store.clear();
    await expect(store.read()).resolves.toBeUndefined();
    expect(new Set(nativeServices)).toEqual(new Set(["ohmyhost-proof-safe-id"]));
  });

  it("stores and verifies one atomic credential entry without legacy pointers", async () => {
    const entries = new Map<string, string>();
    const store = new NativeNapiKeyringCredentialStore(entryFactory(entries));

    await store.replace(NEW);

    expect([...entries.keys()]).toEqual(["credential"]);
    expect(entries.get("credential")).toBe(JSON.stringify(NEW));
    await expect(store.read()).resolves.toEqual(NEW);
  });

  it("keeps one readable last-writer-wins credential across the former ABA interleaving", async () => {
    const entries = new Map<string, string>();
    const firstWritten = deferred<true>();
    const secondVerified = deferred<true>();
    let sets = 0;
    const factory: KeyringEntryFactory = async () => ({
      setPassword: async (password) => {
        sets += 1;
        entries.set("credential", password);
        if (sets === 1) firstWritten.resolve(true);
      },
      getPassword: async () => {
        if (sets === 1) await secondVerified.promise;
        return entries.get("credential");
      },
      deleteCredential: async () => entries.delete("credential"),
    });
    const first = new NativeNapiKeyringCredentialStore(factory);
    const second = new NativeNapiKeyringCredentialStore(factory);

    const firstReplace = first.replace(OLD);
    await firstWritten.promise;
    await second.replace(NEW);
    secondVerified.resolve(true);
    await firstReplace;

    await expect(first.read()).resolves.toEqual(NEW);
    expect(entries.get("credential")).toBe(JSON.stringify(NEW));
  });

  it("removes and verifies the single credential entry on logout", async () => {
    const entries = new Map([["credential", JSON.stringify(OLD)]]);
    const store = new NativeNapiKeyringCredentialStore(entryFactory(entries));

    await store.clear();

    expect(entries.size).toBe(0);
    await expect(store.read()).resolves.toBeUndefined();
  });

  it("maps native failures to a stable redacted error", async () => {
    const store = new NativeNapiKeyringCredentialStore(async () => {
      throw new CredentialStoreUnavailableError();
    });

    await expect(store.read()).rejects.toEqual(new CredentialStoreUnavailableError());
  });

  it("reports invalid stored or post-write values as integrity failures", async () => {
    const invalidRead = new NativeNapiKeyringCredentialStore(
      entryFactory(new Map([["credential", "tampered"]])),
    );
    await expect(invalidRead.read()).rejects.toBeInstanceOf(CredentialStoreIntegrityError);

    const entries = new Map<string, string>();
    const invalidVerification = new NativeNapiKeyringCredentialStore(async () => ({
      setPassword: async (password) => {
        entries.set("credential", password);
      },
      getPassword: async () => "tampered",
      deleteCredential: async () => entries.delete("credential"),
    }));
    await expect(invalidVerification.replace(NEW)).rejects.toBeInstanceOf(
      CredentialStoreIntegrityError,
    );
  });

  it("reports a surviving entry after clear as an integrity failure", async () => {
    const store = new NativeNapiKeyringCredentialStore(async () => ({
      setPassword: async () => undefined,
      getPassword: async () => JSON.stringify(OLD),
      deleteCredential: async () => true,
    }));

    await expect(store.clear()).rejects.toBeInstanceOf(CredentialStoreIntegrityError);
  });
});

interface Deferred<Value> {
  readonly promise: Promise<Value>;
  resolve(value: Value): void;
}

const deferred = <Value>(): Deferred<Value> => {
  let resolvePromise!: (value: Value) => void;
  const promise = new Promise<Value>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
};

const entryFactory = (entries: Map<string, string>) => async (account: string) => ({
  setPassword: async (password: string) => {
    entries.set(account, password);
  },
  getPassword: async () => entries.get(account),
  deleteCredential: async () => entries.delete(account),
});
