import { describe, expect, it, vi } from "vitest";
import {
  createDatabaseRegistry,
  readDatabaseBindingScope,
  type DatabaseRegistryKeyRing,
} from "../src/registry.js";

const organizationId = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const projectId = "01ARZ3NDEKTSV4RRFFQ69G5FAW";
const environmentId = "01ARZ3NDEKTSV4RRFFQ69G5FAX";
const scope = {
  organizationId,
  projectId,
  physicalEnvironmentId: environmentId,
  region: "us" as const,
};
const input = {
  ...scope,
  operationId: "01ARZ3NDEKTSV4RRFFQ69G5FAY",
  registrationVersion: 1,
  providerProjectId: "test-project-123",
  branchId: "br-test-123",
  originHost: "ep-test-pooler.us-east-1.aws.neon.tech",
  originDatabase: "neondb" as const,
  originUser: `ohmyho_rw_${environmentId.toLowerCase()}`,
  authorizedEnvironmentIds: [environmentId],
  pooledConnectionString: `postgresql://ohmyho_rw_${environmentId.toLowerCase()}:private-password@ep-test-pooler.us-east-1.aws.neon.tech/neondb?sslmode=require`,
};
const binding = { ...scope, environmentId, registrationVersion: 1 };

const CURRENT_KEY = { keyVersion: 1, keyBase64: btoa("k".repeat(32)) };
function harness(initial?: unknown, keyRing: DatabaseRegistryKeyRing = { current: CURRENT_KEY }) {
  let value: unknown = initial;
  let invalidations = 0;
  const registry = createDatabaseRegistry({
    region: "us",
    keyRing,
    storage: {
      async get<T>() {
        return value as T | undefined;
      },
      async put(_key: string, next: unknown) {
        value = structuredClone(next);
      },
    },
    invalidate: async () => {
      invalidations += 1;
    },
  });
  return { registry, stored: () => value, invalidations: () => invalidations };
}

describe("regional database registry", () => {
  it("rebinds only an exact authorized Neon generation to PGCF and permanently fences old bindings", async () => {
    const { registry, stored, invalidations } = harness();
    const expectedRegistration = await registry.register(input);
    const { branchId: _branch, pooledConnectionString: _uri, ...common } = input;
    void _branch;
    void _uri;
    const registration = {
      ...common,
      provider: "pgcf" as const,
      providerProjectId: "p1234567890123456789",
      databaseId: "d1234567890123456789",
      originDatabase: "d1234567890123456789",
      originHost: "database.example.com",
      registrationVersion: 2,
      connectionString: `postgres://ohmyho_rw_${environmentId.toLowerCase()}:pgcf-private-password@database.example.com/d1234567890123456789`,
    };
    // Ordinary registration cannot change provider, even with a later generation.
    await expect(registry.register(registration)).rejects.toThrow();
    await expect(
      registry.rebind({
        expectedRegistration: { ...expectedRegistration, branchId: "br-other" },
        registration,
      }),
    ).rejects.toThrow();
    await expect(
      registry.rebind({
        expectedRegistration,
        registration: { ...registration, registrationVersion: 3 },
      }),
    ).rejects.toThrow();
    await expect(
      registry.rebind({
        expectedRegistration,
        registration: {
          ...registration,
          connectionString: registration.connectionString.replace(
            "database.example.com",
            "attacker.example",
          ),
        },
      }),
    ).rejects.toThrow();
    const receipt = await registry.rebind({ expectedRegistration, registration });
    expect(receipt).toMatchObject({
      provider: "pgcf",
      databaseId: registration.databaseId,
      registrationVersion: 2,
    });
    expect(receipt).not.toHaveProperty("branchId");
    expect(invalidations()).toBe(2);
    await expect(registry.authorize(binding)).rejects.toThrow();
    const rebound = { ...binding, registrationVersion: 2 };
    expect(await registry.authorizeConnection(rebound)).toEqual({
      uri: registration.connectionString,
      receipt,
    });
    expect(await registry.rebind({ expectedRegistration, registration })).toEqual(receipt);
    expect(invalidations()).toBe(2);
    expect(JSON.stringify(stored())).not.toContain("pgcf-private-password");
    const reloaded = harness(stored()).registry;
    expect(await reloaded.authorize(rebound)).toBe(registration.connectionString);
    await expect(reloaded.authorize(binding)).rejects.toThrow();
    await expect(
      reloaded.rebind({
        expectedRegistration,
        registration: { ...registration, providerProjectId: "other" },
      }),
    ).rejects.toThrow();
    const revoked = await reloaded.revoke({
      ...scope,
      operationId: input.operationId,
      registrationVersion: 3,
      expectedRegistration: receipt,
    });
    expect(revoked.status).toBe("revoked");
    await expect(reloaded.authorize(rebound)).rejects.toThrow();
    const fresh = harness().registry;
    expect(await fresh.register(registration)).toEqual(receipt);
  });

  it("encrypts registered credentials, binds all scope metadata, and makes replay exact", async () => {
    const { registry, stored } = harness();
    const receipt = await registry.register(input);
    expect(receipt.status).toBe("active");
    expect(JSON.stringify(receipt)).not.toContain("password");
    expect(JSON.stringify(stored())).not.toContain("password");
    expect(await registry.authorize(binding)).toBe(input.pooledConnectionString);
    expect(await registry.register(input)).toEqual(receipt);
    await expect(registry.register({ ...input, branchId: "br-different" })).rejects.toThrow();
    await expect(
      registry.authorize({ ...binding, environmentId: "01ARZ3NDEKTSV4RRFFQ69G5FAZ" }),
    ).rejects.toThrow();
    await expect(registry.authorize({ ...binding, projectId: organizationId })).rejects.toThrow();
    await expect(
      registry.register({
        ...input,
        registrationVersion: 2,
        pooledConnectionString: input.pooledConnectionString.replace("ep-test", "ep-other"),
      }),
    ).rejects.toThrow();
    expect(readDatabaseBindingScope(binding, "us")).toEqual(binding);
    expect(() =>
      readDatabaseBindingScope({ ...binding, registrationVersion: undefined }, "us"),
    ).toThrow();
    expect(() => readDatabaseBindingScope(binding, "eu")).toThrow();
    expect(await harness(stored()).registry.authorize(binding)).toBe(input.pooledConnectionString);
    const tampered = structuredClone(stored()) as { receipt: { branchId: string } };
    tampered.receipt.branchId = "br-tampered";
    await expect(harness(tampered).registry.authorize(binding)).rejects.toThrow(
      "decryption failed",
    );
    const malformed = structuredClone(stored()) as { fingerprint: unknown };
    malformed.fingerprint = null;
    await expect(harness(malformed).registry.inspect(scope)).rejects.toThrow();
    const upgraded = {
      ...input,
      operationId: "01ARZ3NDEKTSV4RRFFQ69G5FAZ",
      registrationVersion: 2,
    };
    expect(await registry.register(upgraded)).toMatchObject({ registrationVersion: 2 });
    expect(await registry.authorize(binding)).toBe(input.pooledConnectionString);
    expect(await registry.authorize({ ...binding, registrationVersion: 2 })).toBe(
      input.pooledConnectionString,
    );
    const advancing = registry.register({ ...upgraded, registrationVersion: 3 });
    await Promise.resolve();
    const concurrent = Array.from({ length: 16 }, () => registry.authorize(binding));
    await advancing;
    expect(await Promise.all(concurrent)).toEqual(
      Array.from({ length: 16 }, () => input.pooledConnectionString),
    );
    for (const credentialsChanged of [false, true]) {
      const decryptStarted = Promise.withResolvers<undefined>();
      const releaseDecrypt = Promise.withResolvers<undefined>();
      const decrypt = crypto.subtle.decrypt.bind(crypto.subtle);
      const paused = vi.spyOn(crypto.subtle, "decrypt").mockImplementationOnce(async (...args) => {
        decryptStarted.resolve(undefined);
        await releaseDecrypt.promise;
        return decrypt(...args);
      });
      const authorizing = registry.authorize(binding);
      // Observe rejection immediately, including when a registration assertion fails.
      const settled = authorizing.catch(() => undefined);
      const nextConnectionString = credentialsChanged
        ? input.pooledConnectionString.replace("private-password", "rotated-password")
        : input.pooledConnectionString;
      try {
        await decryptStarted.promise;
        await registry.register({
          ...upgraded,
          registrationVersion: credentialsChanged ? 5 : 4,
          pooledConnectionString: nextConnectionString,
        });
        releaseDecrypt.resolve(undefined);
        if (credentialsChanged)
          await expect(authorizing).rejects.toThrow("project_database_unavailable");
        else await expect(authorizing).resolves.toBe(nextConnectionString);
      } finally {
        releaseDecrypt.resolve(undefined);
        await settled;
        paused.mockRestore();
      }
      expect(await registry.authorize(binding)).toBe(nextConnectionString);
    }
    let persisted: unknown;
    let fail = true;
    const uncertain = createDatabaseRegistry({
      region: "us",
      keyRing: { current: CURRENT_KEY },
      storage: {
        async get<T>() {
          return persisted as T | undefined;
        },
        async put(_key, value) {
          persisted = structuredClone(value);
          if (fail) {
            fail = false;
            throw new Error("uncertain storage write");
          }
        },
      },
      invalidate: async () => undefined,
    });
    await expect(uncertain.register(input)).rejects.toThrow("project_database_unavailable");
    expect(await uncertain.register(input)).toEqual(receipt);
    expect(await uncertain.authorize(binding)).toBe(input.pooledConnectionString);
  });
  it("authorizes independent data identities across continuous generations without reviving withdrawn bindings", async () => {
    const dataId = "01ARZ3NDEKTSV4RRFFQ69G5FB0";
    const prodId = "01ARZ3NDEKTSV4RRFFQ69G5FAZ";
    const registration = {
      ...input,
      physicalEnvironmentId: dataId,
      originUser: `ohmyho_rw_${dataId.toLowerCase()}`,
      pooledConnectionString: input.pooledConnectionString.replaceAll(
        environmentId.toLowerCase(),
        dataId.toLowerCase(),
      ),
      authorizedEnvironmentIds: [environmentId, prodId],
    };
    const h = harness();
    const dev = { ...binding, physicalEnvironmentId: dataId };
    const prod = { ...dev, environmentId: prodId };
    await h.registry.register(registration);
    expect(await h.registry.authorize(dev)).toBe(registration.pooledConnectionString);
    expect(await h.registry.authorize(prod)).toBe(registration.pooledConnectionString);
    await h.registry.register({
      ...registration,
      registrationVersion: 2,
      authorizedEnvironmentIds: [prodId],
    });
    await expect(h.registry.authorize(dev)).rejects.toThrow("project_database_unavailable");
    expect(await h.registry.authorize(prod)).toBe(registration.pooledConnectionString);
    await expect(h.registry.authorize({ ...prod, registrationVersion: 3 })).rejects.toThrow();
    await h.registry.register({ ...registration, registrationVersion: 3 });
    const resumed = harness(h.stored()).registry;
    await expect(resumed.authorize(dev)).rejects.toThrow("project_database_unavailable");
    expect(await resumed.authorize({ ...dev, registrationVersion: 3 })).toBe(
      registration.pooledConnectionString,
    );
    expect(await resumed.authorize(prod)).toBe(registration.pooledConnectionString);
  });
  it("keeps the physical target immutable when a higher generation changes its authorized environments", async () => {
    const h = harness();
    await h.registry.register(input);
    for (const changed of [
      { providerProjectId: "project-different" },
      { branchId: "br-different" },
      {
        originHost: "ep-other-pooler.us-east-1.aws.neon.tech",
        pooledConnectionString: input.pooledConnectionString.replaceAll("ep-test", "ep-other"),
      },
    ]) {
      await expect(
        h.registry.register({ ...input, registrationVersion: 2, ...changed }),
      ).rejects.toThrow("project_database_unavailable");
      expect(await h.registry.authorize(binding)).toBe(input.pooledConnectionString);
    }
  });
  it("revokes a generation durably and invalidates work before returning", async () => {
    const { registry, invalidations } = harness();
    await registry.register(input);
    const revoke = { ...scope, operationId: "01ARZ3NDEKTSV4RRFFQ69G5FAZ", registrationVersion: 2 };
    const receipt = await registry.revoke(revoke);
    expect(receipt.status).toBe("revoked");
    expect(await registry.revoke(revoke)).toEqual(receipt);
    expect(invalidations()).toBe(2);
    await expect(registry.authorize(binding)).rejects.toThrow();
    await expect(registry.register(input)).rejects.toThrow();
    expect(await registry.inspect(scope)).toEqual(receipt);
    const pending = harness().registry;
    const expectedRegistration = {
      ...(await harness().registry.register(input)),
      status: "active" as const,
    };
    const tombstone = await pending.revoke({ ...revoke, expectedRegistration });
    expect(tombstone.status).toBe("revoked");
    expect(await pending.revoke({ ...revoke, expectedRegistration })).toEqual(tombstone);
    await expect(pending.register(input)).rejects.toThrow();
    await expect(
      pending.revoke({
        ...revoke,
        expectedRegistration: { ...expectedRegistration, branchId: "br-foreign" },
      }),
    ).rejects.toThrow();
    await expect(harness().registry.revoke(revoke)).rejects.toThrow();
  });

  it("reads a credential sealed under the previous key and re-seals it under the current key", async () => {
    const NEXT_KEY = { keyVersion: 2, keyBase64: btoa("c".repeat(32)) };
    const sealed = harness();
    await sealed.registry.register(input);
    // The credential was sealed under version 1; version 2 becomes current and version 1 previous.
    const reading = harness(sealed.stored(), { current: NEXT_KEY, previous: CURRENT_KEY });
    expect(await reading.registry.authorize(binding)).toBe(input.pooledConnectionString);
    expect((reading.stored() as { credential: { keyVersion: number } }).credential.keyVersion).toBe(
      2,
    );
    // Once re-sealed, version 1 is no longer needed to read the credential.
    const later = harness(reading.stored(), { current: NEXT_KEY });
    expect(await later.registry.authorize(binding)).toBe(input.pooledConnectionString);
  });

  it("refuses a credential sealed under a key version that the ring no longer holds", async () => {
    const before = harness();
    await before.registry.register(input);
    const retired = harness(before.stored(), {
      current: { keyVersion: 3, keyBase64: btoa("z".repeat(32)) },
    });
    await expect(retired.registry.authorize(binding)).rejects.toThrow();
  });
});
