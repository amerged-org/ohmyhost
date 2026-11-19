import { expect, it } from "vitest";
import { ProjectDatabaseAccessError, type IssuedProjectDatabaseAccess } from "@ohmyhost/database";
import { PgcfProviderError, type PgcfOperation } from "@ohmyhost/provider-pgcf";
import {
  issuePgcfDatabaseAccess,
  revokePgcfDatabaseAccess,
  type PgcfAccessProvider,
} from "../src/pgcf-access.js";

const projectId = "prj_abcdefghijklmnopqrst",
  databaseId = "abcdefghijklmnopqrst",
  roleName = "ohmyho_da_00000000000000000000000004_abcd1234";
const access = {
  accessId: "00000000000000000000000005",
  providerProjectId: projectId,
  databaseId,
  roleName,
};
const operation = (status: PgcfOperation["status"]): PgcfOperation => ({
  id: "op_abcdefghijklmnopqrst",
  projectId,
  databaseId,
  generation: 1,
  kind: "database.role.delete",
  status,
  errorCode: null,
});
const unexpected = () => {
  throw new Error("Unexpected provider call");
};
const role = { name: roleName } as Awaited<ReturnType<PgcfAccessProvider["readRoles"]>>[number];
function provider(overrides: Partial<PgcfAccessProvider>): PgcfAccessProvider {
  return {
    projectId,
    createRole: unexpected,
    deleteRole: unexpected,
    readDatabase: unexpected,
    readRoles: async () => [],
    readOperation: async () => operation("succeeded"),
    readConnection: unexpected,
    ...overrides,
  } as PgcfAccessProvider;
}
const connect = async () => unexpected();

it("treats a role the provider no longer knows as dropped, but never while it is still listed", async () => {
  const missing = new PgcfProviderError("rejected", 404);
  const recorded: string[] = [];
  const dependencies = {
    connect,
    recordOperation: async (kind: string) => void recorded.push(kind),
    access,
  };
  await expect(
    revokePgcfDatabaseAccess({
      ...dependencies,
      provider: provider({
        deleteRole: async () => {
          throw missing;
        },
      }),
    }),
  ).resolves.toEqual({ dropped: true });
  await expect(
    revokePgcfDatabaseAccess({
      ...dependencies,
      provider: provider({
        deleteRole: async () => {
          throw missing;
        },
        readRoles: async () => [role],
      }),
    }),
  ).rejects.toBe(missing);
  expect(recorded).toEqual([]);
});

it("ends the roles of a database only when PGCF reports it deleted, never on a bare 404 or a failing read", async () => {
  const missing = new PgcfProviderError("rejected", 404);
  const refuse = async () => {
    throw missing;
  };
  const deleted = {
    id: databaseId,
    projectId,
    desiredState: "deleted",
    observedState: "deleted",
  } as Awaited<ReturnType<PgcfAccessProvider["readDatabase"]>>;
  const dependencies = {
    connect,
    recordOperation: async () => {},
    access,
    waitForCompletion: false,
  };
  // PGCF answers every role call of a deleted database with 404, so the role listing proves nothing there.
  const revoke = (overrides: Partial<PgcfAccessProvider>, target = access) =>
    revokePgcfDatabaseAccess({
      ...dependencies,
      access: target,
      provider: provider({ deleteRole: refuse, readRoles: refuse, ...overrides }),
    });
  await expect(revoke({ readDatabase: async () => deleted })).resolves.toEqual({ dropped: true });
  const notGone: Partial<PgcfAccessProvider>[] = [
    { readDatabase: async () => ({ ...deleted, observedState: "deleting" }) },
    { readDatabase: async () => ({ ...deleted, desiredState: "running", observedState: "ready" }) },
    { readDatabase: async () => ({ ...deleted, id: "zyxwvutsrqponmlkjihg" }) },
    { readDatabase: async () => ({ ...deleted, projectId: "prj_zyxwvutsrqponmlkjihg" }) },
    { readDatabase: refuse },
    {
      readDatabase: async () => {
        throw new PgcfProviderError("rejected", 503);
      },
    },
  ];
  for (const overrides of notGone)
    await expect(revoke(overrides)).rejects.toBeInstanceOf(PgcfProviderError);
  // A role deletion PGCF finished is confirmed by the same rule, not by a listing that now answers 404.
  const finished = { ...access, providerDeleteOperationId: "op_abcdefghijklmnopqrst" };
  await expect(revoke({ readDatabase: async () => deleted }, finished)).resolves.toEqual({
    dropped: true,
  });
  await expect(
    revoke({ readDatabase: async () => ({ ...deleted, observedState: "ready" }) }, finished),
  ).rejects.toBe(missing);
  // A role deletion recorded before the database was deleted: its operation answers 404 or never finishes, and the
  // access is still finished once the database is confirmed gone; without that confirmation nothing changes.
  const live = { ...deleted, desiredState: "running", observedState: "ready" } as typeof deleted;
  const stuck = { readOperation: refuse, readDatabase: async () => deleted };
  await expect(revoke(stuck, finished)).resolves.toEqual({ dropped: true });
  const pending = async () => operation("pending");
  await expect(
    revoke({ readOperation: pending, readDatabase: async () => deleted }, finished),
  ).resolves.toEqual({
    dropped: true,
  });
  await expect(
    revoke({ readOperation: refuse, readDatabase: async () => live }, finished),
  ).rejects.toBe(missing);
  await expect(revoke({ readOperation: refuse, readDatabase: refuse }, finished)).rejects.toBe(
    missing,
  );
  await expect(
    revoke({ readOperation: pending, readDatabase: async () => live }, finished),
  ).resolves.toEqual({
    dropped: false,
  });
});

it("records a pending role deletion and confirms the drop once the provider operation succeeds", async () => {
  const recorded: [string, string][] = [];
  let reads = 0;
  const result = await revokePgcfDatabaseAccess({
    connect,
    recordOperation: async (kind, id) => void recorded.push([kind, id]),
    access,
    provider: provider({
      deleteRole: async () => ({ operation: operation("pending") }) as never,
      readOperation: async () => operation(++reads < 2 ? "running" : "succeeded"),
    }),
  });
  expect(result).toEqual({ dropped: true });
  expect(recorded).toEqual([["delete", "op_abcdefghijklmnopqrst"]]);
  expect(reads).toBe(2);
});

/** Mirrors the control store: a delete operation id is set once, then replaced only by compare-and-set on the failed id. */
function storeRecorder(stored: string | null) {
  const recorded: [string, string, string | undefined][] = [];
  let current = stored;
  return {
    recorded,
    get current() {
      return current;
    },
    recordOperation: async (kind: "create" | "delete", id: string, previous?: string) => {
      if (current === id) return;
      if (current !== (previous ?? null)) throw new ProjectDatabaseAccessError("scope");
      current = id;
      recorded.push([kind, id, previous]);
    },
  };
}

it("re-issues a failed role deletion under a new key and confirms the drop from the new operation", async () => {
  const keys: string[] = [];
  const failedId = "op_failedfailedfailedfai";
  const failed = { ...operation("failed"), id: failedId };
  const deleteRole = async (_databaseId: string, _roleName: string, key: string) => {
    keys.push(key);
    return { operation: operation("succeeded") } as never;
  };
  const first = storeRecorder(null);
  await revokePgcfDatabaseAccess({
    connect,
    recordOperation: first.recordOperation,
    access,
    provider: provider({ deleteRole }),
  });
  // The store already holds the failed operation the re-issue is replacing.
  const store = storeRecorder(failedId);
  const result = await revokePgcfDatabaseAccess({
    connect,
    recordOperation: store.recordOperation,
    access: { ...access, providerDeleteOperationId: failedId },
    provider: provider({
      deleteRole,
      readOperation: async (id) => (id === failedId ? failed : operation("succeeded")),
      readRoles: async () => [],
    }),
  });
  expect(result).toEqual({ dropped: true });
  expect(keys).toHaveLength(2);
  expect(keys[1]).not.toBe(keys[0]);
  expect(store.recorded).toEqual([["delete", "op_abcdefghijklmnopqrst", failedId]]);
});

it("keeps polling a re-issued deletion that has not finished, recording it under the failed id", async () => {
  const failedId = "op_failedfailedfailedfai";
  const failed = { ...operation("failed"), id: failedId };
  const store = storeRecorder(failedId);
  let reads = 0;
  const result = await revokePgcfDatabaseAccess({
    connect,
    recordOperation: store.recordOperation,
    access: { ...access, providerDeleteOperationId: failedId },
    provider: provider({
      deleteRole: async () => ({ operation: operation("pending") }) as never,
      readOperation: async (id) =>
        id === failedId ? failed : operation(++reads < 2 ? "running" : "succeeded"),
      readRoles: async () => [],
    }),
  });
  expect(result).toEqual({ dropped: true });
  expect(reads).toBe(2);
  expect(store.recorded).toEqual([["delete", "op_abcdefghijklmnopqrst", failedId]]);
});

it("re-issues a role deletion that fails twice and finishes under a third key", async () => {
  const ids = ["a", "b", "c"].map((letter) => `op_${letter.repeat(20)}`);
  const statuses: PgcfOperation["status"][] = ["failed", "failed", "succeeded"];
  const operations = new Map<string, PgcfOperation>();
  const byKey = new Map<string, PgcfOperation>();
  const keys: string[] = [];
  const deleteRole = async (_databaseId: string, _roleName: string, key: string) => {
    keys.push(key);
    const existing = byKey.get(key);
    if (existing) return { operation: existing } as never;
    const issued = { ...operation(statuses[byKey.size] ?? "failed"), id: ids[byKey.size] ?? "" };
    byKey.set(key, issued);
    operations.set(issued.id, issued);
    return { operation: issued } as never;
  };
  const readOperation = async (id: string) => {
    const found = operations.get(id);
    if (!found) throw new Error("Unexpected operation read");
    return found;
  };
  const store = storeRecorder(null);
  const pass = () =>
    revokePgcfDatabaseAccess({
      connect,
      recordOperation: store.recordOperation,
      access: { ...access, providerDeleteOperationId: store.current },
      provider: provider({ deleteRole, readOperation, readRoles: async () => [] }),
    });
  const results = [await pass(), await pass(), await pass()];
  expect(results).toEqual([{ dropped: false }, { dropped: false }, { dropped: true }]);
  expect(store.recorded).toEqual([
    ["delete", ids[0], undefined],
    ["delete", ids[1], ids[0]],
    ["delete", ids[2], ids[1]],
  ]);
  expect(new Set(keys).size).toBe(3);
  expect(store.current).toBe(ids[2]);
});

it("propagates a stale record instead of treating the role as dropped", async () => {
  const failedId = "op_failedfailedfailedfai";
  const failed = { ...operation("failed"), id: failedId };
  await expect(
    revokePgcfDatabaseAccess({
      connect,
      recordOperation: async () => {
        throw new ProjectDatabaseAccessError("scope");
      },
      access: { ...access, providerDeleteOperationId: failedId },
      provider: provider({
        readOperation: async () => failed,
        deleteRole: async () => ({ operation: operation("pending") }) as never,
        readRoles: async () => [],
      }),
    }),
  ).rejects.toBeInstanceOf(ProjectDatabaseAccessError);
});

it("does not connect to a new role before the database has observed its generation", async () => {
  const databaseId = "abcdefghijklmnopqrst";
  const roleName = "ohmyho_da_00000000000000000000000004_expiry00";
  // A write credential: a read credential first opens the owner connection, before any role exists.
  const member = "ohmyho_rw_00000000000000000000000004";
  const host = `${databaseId}.db.example.com`;
  const nominal = new Date(Date.now() + 3600000).toISOString();
  const accepted = Object.freeze({
    provider: "pgcf",
    accessId: "00000000000000000000000005",
    roleName,
    memberRole: member,
    mode: "write",
    environment: "dev",
    environmentId: "00000000000000000000000004",
    dataEnvironmentId: "00000000000000000000000004",
    providerProjectId: projectId,
    databaseId,
    originHost: host,
    issuedAt: new Date().toISOString(),
    expiresAt: nominal,
    label: "observed generation",
  }) as Extract<IssuedProjectDatabaseAccess, { provider: "pgcf" }>;
  const view = {
    databaseId,
    name: roleName,
    owner: false,
    bypassRls: false,
    passwordRevision: 1,
    connectionLimit: 5,
    validUntil: nominal,
    memberOf: [member],
    membershipOptions: { inherit: true, set: false },
  };
  const observed = [0, 1, 2];
  let reads = 0;
  let connectedAt: number | undefined;
  await expect(
    issuePgcfDatabaseAccess({
      accepted,
      projectId: "00000000000000000000000002",
      assertScope: async () => {},
      recordOperation: async () => {
        throw new Error("Unexpected provider operation");
      },
      connect: async () => {
        connectedAt = reads;
        throw new Error("connect reached");
      },
      provider: provider({
        createRole: async () => view as never,
        readRoles: async () => [view as never],
        readDatabase: async () => {
          const generation = observed[Math.min(reads, observed.length - 1)] ?? 0;
          reads++;
          return {
            id: databaseId,
            generation: 2,
            observedGeneration: generation,
          } as never;
        },
        readConnection: async () =>
          ({
            host,
            consume: async <T>(consume: (value: string) => Promise<T>) =>
              consume(`postgresql://${roleName}:synthetic-fixture-password@${host}/${databaseId}`),
          }) as never,
      }),
    }),
  ).rejects.toThrow("connect reached");
  expect(connectedAt).toBe(3);
});
