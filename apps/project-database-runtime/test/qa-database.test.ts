import { describe, expect, it } from "vitest";
import {
  authorizeQaDatabase,
  qaDatabaseDeadline,
  readQaDatabaseCall,
  type QaDatabaseBindings,
} from "../src/qa-database.js";
import { executeQaDatabase, type ProjectDatabaseClient } from "../src/service.js";
import { readDatabaseRegistrationReceipt } from "../src/registry.js";

const id = (value: number) => String(value).padStart(26, "0");
const fixtures = [
  "react-vite",
  "vanilla-vite",
  "tanstack-start",
  "next-edge",
  "astro-edge",
  "next-native-auth",
  "next-app-mail",
];
const manifest = () => ({
  platform: "development",
  projects: fixtures.map((fixture, index) => ({
    fixture,
    organizationId: id(1),
    projectId: id(10 + index),
    environmentId: id(20 + index),
    physicalEnvironmentId: id(30 + index),
    registrationVersion: 1,
    region: "eu",
    handle: `qa-${index}`,
    origin: `https://dev-qa-${index}.dev.check.omh.st`,
    principalId: "qa-operator",
    devAccessEpoch: 1,
  })),
});
const call = (scope: unknown) => ({
  platform: "development",
  scope,
  operation: "query",
  input: { text: "SELECT 1", values: [] },
});

const rawRegistration = () => ({
  organizationId: id(1),
  projectId: id(10),
  environmentId: undefined,
  physicalEnvironmentId: id(30),
  region: "eu",
  operationId: id(50),
  registrationVersion: 1,
  provider: "pgcf",
  providerProjectId: "p1234567890123456789",
  databaseId: "d1234567890123456789",
  originHost: "database.example.com",
  originDatabase: "d1234567890123456789",
  originUser: `ohmyho_rw_${id(30).toLowerCase()}`,
  authorizedEnvironmentIds: [id(20)],
  status: "active",
});
function fixture() {
  const { environmentId: _unused, ...raw } = rawRegistration();
  void _unused;
  const receipt = readDatabaseRegistrationReceipt(raw);
  const state = {
    assignments: {
      dataMode: "isolated",
      dev: { environment: "dev", environmentId: id(20), dataEnvironmentId: id(30) },
      prod: { environment: "prod", environmentId: id(40), dataEnvironmentId: id(41) },
    },
    registrationGenerations: [{ dataEnvironmentId: id(30), registrationVersion: 1 }],
  };
  let currentReceipt: unknown = receipt,
    localReceipt = receipt,
    granted = true,
    funded = true;
  const env: QaDatabaseBindings = {
    DATABASE_REGION: "eu",
    QA_DATABASE_PLATFORM: "development",
    QA_DATABASE_MANIFEST: JSON.stringify(manifest()),
    QA_DATABASE_AUTHORITY: {
      readApiProjectDataChangeState: async () => structuredClone(state),
      readRuntimeBinding: async () => currentReceipt,
    },
    QA_DEV_ACCESS: { authorizeDevAccessSession: async () => granted },
    QA_CREDIT: {
      read: async (rawInput) => {
        const input = rawInput as Record<string, unknown>;
        return {
          organizationId: input["organizationId"],
          projectId: input["projectId"],
          environmentId: input["environmentId"],
          allowed: funded,
          paidAllowed: funded,
          reason: funded ? null : "insufficient_organization_credits",
          checkedAt: "2026-11-15T00:00:00.000Z",
          expiresAt: "2026-11-15T00:01:00.000Z",
        };
      },
    },
  };
  return {
    env,
    state,
    receipt,
    inspect: async () => localReceipt,
    setCore: (value: unknown) => {
      currentReceipt = value;
    },
    setLocal: (value: typeof receipt) => {
      localReceipt = value;
    },
    setGrant: (value: boolean) => {
      granted = value;
    },
    setFunding: (value: boolean) => {
      funded = value;
    },
  };
}

describe("trusted Development QA database authority", () => {
  it("pins seven fixture scopes and refuses foreign, shared, stale, revoked and unfunded authority", async () => {
    const f = fixture();
    const scope = readQaDatabaseCall(call(manifest().projects[0]), f.env).scope;
    const check = () =>
      authorizeQaDatabase(f.env, scope, f.inspect, () => Date.parse("2026-11-15T00:00:01.000Z"));
    await expect(check()).resolves.toBeUndefined();
    const forged = { ...manifest().projects[0], organizationId: id(99) };
    expect(() => readQaDatabaseCall(call(forged), f.env)).toThrow();
    expect(() =>
      readQaDatabaseCall(call({ ...manifest().projects[0], extra: 1 }), f.env),
    ).toThrow();
    expect(() =>
      readQaDatabaseCall(call(manifest().projects[0]), {
        ...f.env,
        QA_DATABASE_PLATFORM: "production",
      }),
    ).toThrow();
    const duplicate = manifest();
    const first = duplicate.projects[0],
      second = duplicate.projects[1];
    if (!first || !second) throw new Error("fixture missing");
    second.physicalEnvironmentId = first.physicalEnvironmentId;
    expect(() =>
      readQaDatabaseCall(call(duplicate.projects[0]), {
        ...f.env,
        QA_DATABASE_MANIFEST: JSON.stringify(duplicate),
      }),
    ).toThrow();
    f.state.assignments.dataMode = "shared";
    await expect(check()).rejects.toThrow();
    f.state.assignments.dataMode = "isolated";
    f.state.assignments.dev.dataEnvironmentId = id(99);
    await expect(check()).rejects.toThrow();
    f.state.assignments.dev.dataEnvironmentId = id(30);
    f.state.assignments.prod.dataEnvironmentId = id(30);
    await expect(check()).rejects.toThrow();
    f.state.assignments.prod.dataEnvironmentId = id(41);
    const generation = f.state.registrationGenerations[0];
    if (!generation) throw new Error("generation missing");
    generation.registrationVersion = 2;
    await expect(check()).rejects.toThrow();
    generation.registrationVersion = 1;
    f.setCore({ ...f.receipt, organizationId: id(99) });
    await expect(check()).rejects.toThrow();
    f.setCore(f.receipt);
    f.setLocal({ ...f.receipt, operationId: id(99) });
    await expect(check()).rejects.toThrow();
    f.setLocal(f.receipt);
    f.setGrant(false);
    await expect(check()).rejects.toThrow();
    f.setGrant(true);
    f.setFunding(false);
    await expect(check()).rejects.toThrow();

    // Exercise the production default clock and verify its instant reaches the credit service.
    // A current decision is admitted; an otherwise identical expired decision is refused.
    const observed: Record<string, unknown>[] = [];
    let expired = false;
    const actualClockEnv: QaDatabaseBindings = {
      ...f.env,
      QA_CREDIT: {
        read: async (input) => {
          const request = input as Record<string, unknown>;
          observed.push(request);
          const instant = Date.parse(String(request["now"]));
          return {
            organizationId: request["organizationId"],
            projectId: request["projectId"],
            environmentId: request["environmentId"],
            allowed: true,
            paidAllowed: true,
            reason: null,
            checkedAt: new Date(instant - 1_000).toISOString(),
            expiresAt: new Date(instant + (expired ? -1 : 60_000)).toISOString(),
          };
        },
      },
    };
    const before = Date.now();
    await expect(authorizeQaDatabase(actualClockEnv, scope, f.inspect)).resolves.toBeUndefined();
    expired = true;
    await expect(authorizeQaDatabase(actualClockEnv, scope, f.inspect)).rejects.toThrow();
    const after = Date.now();
    expect(observed).toHaveLength(2);
    for (const request of observed) {
      expect(request).toMatchObject({
        organizationId: scope.organizationId,
        projectId: scope.projectId,
        environmentId: scope.environmentId,
      });
      expect(typeof request["now"]).toBe("string");
      const instant = Date.parse(String(request["now"]));
      expect(Number.isFinite(instant)).toBe(true);
      expect(instant).toBeGreaterThanOrEqual(before);
      expect(instant).toBeLessThanOrEqual(after);
    }
  });

  it("rolls back when authority changes before commit and never retries an unknown commit", async () => {
    const statements: string[] = [];
    let failCommit = false;
    let terminated = 0;
    let failTermination = false;
    const client: ProjectDatabaseClient = {
      connect: async () => undefined,
      query: async (statement) => {
        statements.push(statement.text);
        if (failCommit && statement.text === "COMMIT") throw new Error("lost commit reply");
        return { command: statement.text.split(" ")[0] ?? "", rows: [], rowCount: 0 };
      },
      end: async () => undefined,
      terminate: async () => {
        terminated += 1;
        if (failTermination) throw new Error("private termination failure");
      },
    };
    const dependencies = { createClient: () => client };
    let fences = 0;
    const revoke = async () => {
      if (++fences === 2) throw new Error("revoked");
    };
    await expect(
      executeQaDatabase(
        "postgres://fixture",
        dependencies,
        "query",
        { text: "INSERT INTO notes VALUES (1)", values: [] },
        revoke,
        qaDatabaseDeadline(),
      ),
    ).rejects.toThrow("revoked");
    expect(statements).toEqual(["BEGIN", "INSERT INTO notes VALUES (1)", "ROLLBACK"]);
    statements.length = 0;
    failCommit = true;
    await expect(
      executeQaDatabase(
        "postgres://fixture",
        dependencies,
        "transaction",
        [{ text: "INSERT INTO notes VALUES (1)", values: [] }],
        async () => undefined,
        qaDatabaseDeadline(),
      ),
    ).rejects.toMatchObject({ code: "08007" });
    expect(statements.filter((statement) => statement === "COMMIT")).toHaveLength(1);
    expect(
      statements.filter((statement) => statement === "INSERT INTO notes VALUES (1)"),
    ).toHaveLength(1);
    statements.length = 0;
    failCommit = false;
    fences = 0;
    const stalled = () => {
      fences += 1;
      return fences === 2 ? new Promise<void>(() => undefined) : Promise.resolve();
    };
    await expect(
      executeQaDatabase(
        "postgres://fixture",
        dependencies,
        "query",
        { text: "INSERT INTO notes VALUES (1)", values: [] },
        stalled,
        qaDatabaseDeadline(25),
      ),
    ).rejects.toThrow("qa_database_unavailable");
    expect(statements).toEqual(["BEGIN", "INSERT INTO notes VALUES (1)"]);
    expect(terminated).toBe(1);

    // A failed socket termination must not replace the timeout or replay a possible write.
    statements.length = 0;
    fences = 0;
    failTermination = true;
    await expect(
      executeQaDatabase(
        "postgres://fixture",
        dependencies,
        "query",
        { text: "INSERT INTO notes VALUES (1)", values: [] },
        stalled,
        qaDatabaseDeadline(25),
      ),
    ).rejects.toThrow("qa_database_unavailable");
    expect(statements).toEqual(["BEGIN", "INSERT INTO notes VALUES (1)"]);
    expect(terminated).toBe(2);
  });
});
