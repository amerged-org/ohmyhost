import { describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import {
  NATIVE_AUTH_SCHEMA_MIGRATION_SHA256,
  NATIVE_AUTH_SCHEMA_MIGRATION_VERSION,
  NATIVE_AUTH_SCHEMA_V1_SHA256,
  NATIVE_AUTH_SCHEMA_V2_SHA256,
} from "@ohmyhost/contracts/native-auth";
import { createNativeAuthRegistry, type NativeAuthRegistryReceipt } from "../src/registry.js";

const id = "01K2F3G4H5J6K7M8N9P0QRSTVW";
const environmentId = "01K2F3G4H5J6K7M8N9P0QRSTVZ";
const receipt: NativeAuthRegistryReceipt = {
  organizationId: id,
  projectId: id,
  environmentId,
  operationId: id,
  claimId: id,
  providerProjectId: "prj_12345678901234567890",
  databaseId: "a1234567890123456789",
  regionId: "eu-dev",
  originHost: "pgcf.example.com",
  schema: `omh_auth_${environmentId.toLowerCase()}`,
  role: `omh_ar_${environmentId.toLowerCase()}`,
  targetVersion: 1,
  registryVersion: 1,
  registryReference: `${id}:${environmentId}`,
  status: "active",
};
const connectionString = `postgres://${receipt.role}:secret@${receipt.originHost}/${receipt.databaseId}?sslmode=require`;
const registration = (r: NativeAuthRegistryReceipt, uri = connectionString) => {
  const { status, ...metadata } = r;
  expect(status).toBe("active");
  return { ...metadata, connectionString: uri };
};

describe("private Native Auth credential registry", () => {
  it("pins the exact Native database migration cohort", async () => {
    expect(NATIVE_AUTH_SCHEMA_MIGRATION_VERSION).toBe(3);
    const sql = await readFile(new URL("../schema.sql", import.meta.url));
    expect(createHash("sha256").update(sql).digest("hex")).toBe(NATIVE_AUTH_SCHEMA_V1_SHA256);
    const second = await readFile(
      new URL("../migrations/002-invitation-receipt-digest.sql", import.meta.url),
    );
    expect(createHash("sha256").update(second).digest("hex")).toBe(NATIVE_AUTH_SCHEMA_V2_SHA256);
    const third = await readFile(new URL("../migrations/003-social-flow.sql", import.meta.url));
    expect(createHash("sha256").update(third).digest("hex")).toBe(
      NATIVE_AUTH_SCHEMA_MIGRATION_SHA256,
    );
  });
  it("encrypts credentials and stable engine secret, checks live authority, and revokes", async () => {
    let stored: unknown;
    let live: NativeAuthRegistryReceipt | null = receipt;
    const storage = {
      get: async <T>() => stored as T | undefined,
      put: async (_key: string, value: unknown) => {
        stored = structuredClone(value);
      },
    };
    const authority = {
      authorizeRegistration: vi.fn(async () => true),
      readRegistration: vi.fn(async () => live),
      authorizeRevocation: vi.fn(async () => true),
      authorizeDeletion: vi.fn(async () => false),
      authorizeDeletionQuiescence: vi.fn(async () => false),
    };
    const invalidate = vi.fn(async () => {});
    const options = {
      regionId: "eu-dev" as const,
      keyBase64: btoa("a".repeat(32)),
      storage,
      authority,
      invalidate,
    };
    let registry = createNativeAuthRegistry(options);
    expect(await registry.register(registration(receipt))).toEqual(receipt);
    expect(JSON.stringify(stored)).not.toContain("secret@");
    const first = await registry.resolve({ projectId: id, environmentId });
    expect(JSON.stringify(stored)).not.toContain(first.secret);
    expect(first.connectionString).toBe(connectionString);
    expect(first.secret.length).toBeGreaterThanOrEqual(32);
    const original = structuredClone(stored) as {
      credential: { keyVersion: number };
      engineSecret: unknown;
    };
    registry = createNativeAuthRegistry({
      ...options,
      keyBase64: btoa("z".repeat(32)),
      keyVersion: 20261106,
      additionalKeysJson: JSON.stringify({ 1: options.keyBase64 }),
    });
    const restored = await registry.resolve({ projectId: id, environmentId });
    expect(restored.secret).toBe(first.secret);
    expect(restored.connectionString).toBe(first.connectionString);
    expect(stored).toEqual(original);
    // Restarting under the new master reads the old URI and engine envelope without rewriting either.
    registry = createNativeAuthRegistry({
      ...options,
      keyBase64: btoa("z".repeat(32)),
      keyVersion: 20261106,
      additionalKeysJson: JSON.stringify({ 1: options.keyBase64 }),
    });
    expect((await registry.resolve({ projectId: id, environmentId })).secret).toBe(first.secret);
    const second = { ...receipt, registryVersion: 2 };
    await registry.register(registration(second));
    live = second;
    expect((stored as { credential: { keyVersion: number } }).credential.keyVersion).toBe(20261106);
    expect((stored as { engineSecret: unknown }).engineSecret).toEqual(original.engineSecret);
    expect((await registry.resolve({ projectId: id, environmentId })).secret).toBe(first.secret);
    live = receipt;
    await expect(registry.resolve({ projectId: id, environmentId })).rejects.toThrow(
      "auth_unavailable",
    );
    live = second;
    let resume!: () => void;
    authority.readRegistration.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resume = () => resolve(second);
        }),
    );
    const stalled = registry.resolve({ projectId: id, environmentId }, Date.now() + 50);
    const queued = registry.resolve({ projectId: id, environmentId }, Date.now() + 50);
    await Promise.all([
      expect(stalled).rejects.toThrow("auth_unavailable"),
      expect(queued).rejects.toThrow("auth_unavailable"),
    ]);
    resume();
    expect((await registry.resolve({ projectId: id, environmentId })).secret).toBe(first.secret);
    await registry.revoke({ receipt: second, operationId: id, claimId: id, registryVersion: 3 });
    await expect(registry.resolve({ projectId: id, environmentId })).rejects.toThrow(
      "auth_unavailable",
    );
    expect(invalidate).toHaveBeenCalledTimes(3);
  });

  it("rejects forged target, stale authority and cross-realm resolution", async () => {
    let stored: unknown;
    let authorized = true;
    const registry = createNativeAuthRegistry({
      regionId: "eu-dev",
      keyBase64: btoa("b".repeat(32)),
      storage: {
        get: async <T>() => stored as T | undefined,
        put: async (_key, value) => {
          stored = value;
        },
      },
      authority: {
        authorizeRegistration: async () => authorized,
        readRegistration: async () => receipt,
        authorizeRevocation: async () => authorized,
        authorizeDeletion: async () => false,
        authorizeDeletionQuiescence: async () => false,
      },
      invalidate: async () => {},
    });
    await expect(
      registry.register(
        registration(receipt, connectionString.replace("pgcf.example.com", "evil.example.com")),
      ),
    ).rejects.toThrow();
    await expect(registry.register(registration({ ...receipt, role: "app" }))).rejects.toThrow();
    authorized = false;
    await expect(registry.register(registration(receipt))).rejects.toThrow("auth_unavailable");
    authorized = true;
    await registry.register(registration(receipt));
    await expect(registry.resolve({ projectId: id, environmentId: id })).rejects.toThrow(
      "auth_unavailable",
    );
  });

  it("refuses a lookup when current authority changes during decryption", async () => {
    let stored: unknown;
    let lookups = 0;
    const registry = createNativeAuthRegistry({
      regionId: "eu-dev",
      keyBase64: btoa("c".repeat(32)),
      storage: {
        get: async <T>() => stored as T | undefined,
        put: async (_key, value) => {
          stored = value;
        },
      },
      authority: {
        authorizeRegistration: async () => true,
        readRegistration: async () => (++lookups === 1 ? receipt : null),
        authorizeRevocation: async () => true,
        authorizeDeletion: async () => false,
        authorizeDeletionQuiescence: async () => false,
      },
      invalidate: async () => {},
    });
    await registry.register(registration(receipt));
    await expect(registry.resolve({ projectId: id, environmentId })).rejects.toThrow(
      "auth_unavailable",
    );
    expect(lookups).toBe(2);
  });

  it("purges both private secrets only with the frozen deletion authority and remains erased on replay", async () => {
    let stored: unknown;
    let allowed = false;
    const invalidate = vi.fn(async () => {});
    const registry = createNativeAuthRegistry({
      regionId: "eu-dev",
      keyBase64: btoa("d".repeat(32)),
      storage: {
        get: async <T>() => stored as T | undefined,
        put: async (_key, value) => {
          stored = structuredClone(value);
        },
      },
      authority: {
        authorizeRegistration: async () => true,
        readRegistration: async () => receipt,
        authorizeRevocation: async () => true,
        authorizeDeletion: async () => allowed,
        authorizeDeletionQuiescence: async () => allowed,
      },
      invalidate,
    });
    await registry.register(registration(receipt));
    const deletion = {
      organizationId: id,
      projectId: id,
      environmentId,
      operationId: id,
      registryVersion: 1,
      registryReference: receipt.registryReference,
    };
    await expect(registry.purgeForDeletion(deletion)).rejects.toThrow("auth_unavailable");
    allowed = true;
    await expect(registry.quiesceForDeletion(deletion)).resolves.toEqual({ status: "quiesced" });
    await expect(registry.purgeForDeletion({ ...deletion, registryVersion: 2 })).rejects.toThrow(
      "auth_unavailable",
    );
    await expect(registry.purgeForDeletion(deletion)).resolves.toEqual({ status: "absent" });
    expect(stored).toEqual({ deleted: deletion });
    await expect(registry.purgeForDeletion(deletion)).resolves.toEqual({ status: "absent" });
    await expect(registry.resolve({ projectId: id, environmentId })).rejects.toThrow(
      "auth_unavailable",
    );
    await expect(registry.register(registration(receipt))).rejects.toThrow("auth_unavailable");
    expect(invalidate).toHaveBeenCalledTimes(3);
  });
});
