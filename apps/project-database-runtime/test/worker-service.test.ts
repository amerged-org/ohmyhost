import { describe, expect, it, vi } from "vitest";
import { DatabaseError } from "pg";

vi.mock("cloudflare:workers", () => ({
  // Test-only constructors preserve the runtime-owned context boundary.
  // eslint-disable-next-line @typescript-eslint/no-extraneous-class
  RpcTarget: class {},
  WorkerEntrypoint: class {
    constructor(
      protected readonly ctx: unknown,
      protected readonly env: unknown,
    ) {}
  },
  DurableObject: class {
    constructor(
      protected readonly ctx: unknown,
      protected readonly env: unknown,
    ) {}
  },
}));

import {
  ProjectDatabaseAdmin,
  ProjectDatabaseConnection,
  ProjectDatabaseEnvironment,
  ProjectDatabaseService,
} from "../src/worker-service.js";
import { ProjectDatabaseInputError, ProjectDatabaseResultError } from "../src/service.js";

const organizationId = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const projectId = "01ARZ3NDEKTSV4RRFFQ69G5FAW";
const environmentId = "01ARZ3NDEKTSV4RRFFQ69G5FAX";
const physical = {
  organizationId,
  projectId,
  physicalEnvironmentId: environmentId,
  region: "us" as const,
};
const scope = { ...physical, environmentId, registrationVersion: 1 };
const registration = {
  ...physical,
  operationId: "01ARZ3NDEKTSV4RRFFQ69G5FAY",
  registrationVersion: 1,
  providerProjectId: "project-neon",
  branchId: "br-neon",
  originHost: "ep-test-pooler.us-east-1.aws.neon.tech",
  originDatabase: "neondb",
  originUser: `ohmyho_rw_${environmentId.toLowerCase()}`,
  authorizedEnvironmentIds: [environmentId],
  pooledConnectionString: `postgresql://ohmyho_rw_${environmentId.toLowerCase()}:password@ep-test-pooler.us-east-1.aws.neon.tech/neondb?sslmode=require`,
};

describe("shared project database boundary", () => {
  it("routes only immutable scope, exposes separate administration, and fails closed before registration", async () => {
    let stored: unknown;
    const storage = {
      async get<T>() {
        return stored as T | undefined;
      },
      async put(_key: string, value: unknown) {
        stored = structuredClone(value);
      },
    };
    const names: string[] = [];
    const regions: string[] = [];
    const namespace = {
      jurisdiction(region: string) {
        regions.push(region);
        return this;
      },
      getByName(name: string) {
        names.push(name);
        return object;
      },
    };
    const env = {
      DATABASE_REGION: "us" as const,
      DATABASE_REGISTRY_KEY: btoa("k".repeat(32)),
      DATABASE_ENVIRONMENTS: namespace,
      OHMYHOST_MAIL_GATEWAY: { fetch: async () => new Response(null, { status: 202 }) },
    };
    const object = new ProjectDatabaseEnvironment({ storage }, env);
    const customer = new ProjectDatabaseService({ props: scope }, env);
    const admin = new ProjectDatabaseAdmin({ props: {} }, env);
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      expect(await admin.inspect(physical)).toBeNull();
      await expect(customer.query({ text: "SELECT 1", values: [] })).rejects.toThrow(
        "project_database_query_failed",
      );
      await expect(customer.transaction([{ text: "SELECT 1", values: [] }])).rejects.toThrow(
        "project_database_transaction_failed",
      );
      await expect(customer.open()).rejects.toThrow("project_database_open_failed");
      expect((await customer.fetch(new Request("https://internal/api/auth"))).status).toBe(503);
      expect(await admin.register(registration)).toMatchObject({
        status: "active",
        registrationVersion: 1,
      });
      expect(await admin.inspect(physical)).toMatchObject({ status: "active" });
      expect(
        await admin.revoke({
          ...physical,
          operationId: "01ARZ3NDEKTSV4RRFFQ69G5FAZ",
          registrationVersion: 2,
        }),
      ).toMatchObject({ status: "revoked" });
      await expect(customer.query({ text: "SELECT 1", values: [] })).rejects.toThrow(
        "project_database_query_failed",
      );
      expect(new Set(names)).toEqual(new Set([`${organizationId}:${projectId}:${environmentId}`]));
      expect(new Set(regions)).toEqual(new Set(["us"]));
      const forged = new ProjectDatabaseService({ props: { ...scope, region: "eu" } }, env);
      expect(() => forged.open()).toThrow("project_database_unavailable");
      expect("register" in customer).toBe(false);
      expect("inspect" in customer).toBe(false);
      expect("rebind" in customer).toBe(false);
      expect(() => admin.register(null)).toThrow();
      expect(() => admin.rebind(null)).toThrow();
      const expectedRegistration = await admin.inspect(physical);
      const { branchId: _branch, pooledConnectionString: _uri, ...oldTarget } = registration;
      void _branch;
      void _uri;
      const target = {
        ...oldTarget,
        provider: "pgcf" as const,
        providerProjectId: "p1234567890123456789",
        databaseId: "d1234567890123456789",
        originDatabase: "d1234567890123456789",
        originHost: "database.example.com",
        registrationVersion: 3,
        connectionString: `postgres://ohmyho_rw_${environmentId.toLowerCase()}:fixture-password@database.example.com/d1234567890123456789`,
      };
      await expect(
        admin.rebind({ expectedRegistration, registration: target }),
      ).resolves.toMatchObject({ provider: "pgcf", registrationVersion: 3 });
      await expect(customer.query({ text: "SELECT 1", values: [] })).rejects.toThrow(
        "project_database_query_failed",
      );
      const pgcfCustomer = new ProjectDatabaseService(
        { props: { ...scope, registrationVersion: 3 } },
        env,
      );
      // Resolves the PGCF lane without dispatching any SQL; malformed SQL is rejected locally.
      await expect(pgcfCustomer.query({ text: "", values: [] })).resolves.toEqual({
        type: "ohmyhost.database-error/v1",
        sqlstate: "54000",
      });
      await admin.register({ ...target, registrationVersion: 4 });
      await admin.revoke({
        ...physical,
        operationId: registration.operationId,
        registrationVersion: 5,
      });
    } finally {
      logged.mockRestore();
    }
  });
  it("answers a deterministic runtime limit as the non-retryable SQLSTATE 54000", async () => {
    // A statement over the row, byte, parameter or statement limits fails the same way on every
    // retry, so it must not surface as the retryable database_unavailable.
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      for (const limit of [new ProjectDatabaseInputError(), new ProjectDatabaseResultError()]) {
        const target = new ProjectDatabaseConnection(
          {
            async query() {
              throw limit;
            },
            async close() {},
            async abort() {},
          },
          async () => undefined,
          () => undefined,
        );
        await expect(target.query({ text: "SELECT", values: [] })).resolves.toEqual({
          type: "ohmyhost.database-error/v1",
          sqlstate: "54000",
        });
        await target.close();
      }
      expect(logged.mock.calls.map(([line]) => JSON.parse(String(line)))).toEqual([
        { event: "project_database_connection_query_failed", reason: "limit" },
        { event: "project_database_connection_query_failed", reason: "limit" },
      ]);
    } finally {
      logged.mockRestore();
    }
  });

  it("rechecks held-session authority, preserves SQLSTATE only, and actively expires abandoned sessions", async () => {
    vi.useFakeTimers();
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    let authorized = true;
    let closes = 0;
    let releases = 0;
    const error = Object.assign(new DatabaseError("private SQL", 0, "error"), {
      code: "23505",
      constraint: "users_email_key",
    });
    const connection = {
      async query() {
        throw error;
      },
      async close() {
        closes += 1;
      },
      async abort() {
        closes += 1;
      },
    };
    const target = new ProjectDatabaseConnection(
      connection,
      async () => {
        if (!authorized) throw new Error("private scope");
      },
      () => {
        releases += 1;
      },
    );
    try {
      await expect(target.query({ text: "INSERT", values: [] })).resolves.toEqual({
        type: "ohmyhost.database-error/v1",
        sqlstate: "23505",
      });
      authorized = false;
      await expect(target.query({ text: "SELECT", values: [] })).rejects.toThrow(
        "project_database_connection_query_failed",
      );
      // Losing scope releases the real session immediately, rather than waiting for idle expiry.
      expect(closes).toBe(1);
      expect(releases).toBe(1);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(closes).toBe(1);
      expect(releases).toBe(1);
      await expect(target.query({ text: "SELECT", values: [] })).rejects.toThrow(
        "project_database_connection_query_failed",
      );
      target[Symbol.dispose]();
      await target.close();
      expect(closes).toBe(1);
      expect(JSON.stringify(logged.mock.calls)).not.toContain("private");
      const lifetime = new ProjectDatabaseConnection(
        {
          async query() {
            return 1;
          },
          async close() {
            closes += 1;
          },
          async abort() {
            closes += 1;
          },
        },
        async () => undefined,
        () => undefined,
      );
      for (let index = 0; index < 7; index += 1) {
        await vi.advanceTimersByTimeAsync(4_000);
        await lifetime.query({});
      }
      await vi.advanceTimersByTimeAsync(2_000);
      expect(closes).toBe(2);
      const abandoned = new ProjectDatabaseConnection(
        {
          async query() {
            return null;
          },
          async close() {
            closes += 1;
          },
          async abort() {
            closes += 1;
            throw new Error("socket already closed");
          },
        },
        async () => undefined,
        () => undefined,
      );
      await vi.advanceTimersByTimeAsync(4_000);
      expect(await abandoned.query({})).toBeNull();
      await vi.advanceTimersByTimeAsync(4_999);
      expect(closes).toBe(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(closes).toBe(3);
      abandoned[Symbol.dispose]();
      const neverUsed = new ProjectDatabaseConnection(
        connection,
        async () => undefined,
        () => undefined,
      );
      await vi.advanceTimersByTimeAsync(5_000);
      expect(closes).toBe(4);
      await neverUsed.close();
    } finally {
      logged.mockRestore();
      vi.useRealTimers();
    }
  });

  it("keeps a held session open while queries overlap, and expires it five seconds after the last one", async () => {
    vi.useFakeTimers();
    let aborts = 0;
    const connection = {
      query: (input: { delayMs: number }) =>
        new Promise((resolve) => setTimeout(() => resolve({ rows: [] }), input.delayMs)),
      async close() {},
      async abort() {
        aborts += 1;
      },
    };
    const target = new ProjectDatabaseConnection(
      connection,
      async () => undefined,
      () => undefined,
    );
    try {
      // The first query ends at 0 ms and the second at 100 ms; the third starts at 4 s and ends at 6 s.
      const overlapping = [target.query({ delayMs: 0 }), target.query({ delayMs: 100 })];
      await vi.advanceTimersByTimeAsync(100);
      await Promise.all(overlapping);
      await vi.advanceTimersByTimeAsync(3_900);
      const late = target.query({ delayMs: 2_000 });
      await vi.advanceTimersByTimeAsync(1_050);
      expect(aborts).toBe(0);
      await vi.advanceTimersByTimeAsync(950);
      await expect(late).resolves.toEqual({ rows: [] });
      // Idle expiry runs five seconds after the last query, not before.
      await vi.advanceTimersByTimeAsync(4_999);
      expect(aborts).toBe(0);
      await vi.advanceTimersByTimeAsync(1);
      expect(aborts).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
