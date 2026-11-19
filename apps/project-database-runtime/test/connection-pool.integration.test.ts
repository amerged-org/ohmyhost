import { execFile } from "node:child_process";
import { chmod, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { Pool, type PoolClient } from "pg";
import { expect, it, vi } from "vitest";
vi.mock("cloudflare:workers", () => ({
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
import { ProjectDatabaseEnvironment } from "../src/worker-service.js";
import { startTestPostgres } from "../../control-api/test/postgres.js";
import { DatabaseLanePool, pooledClientDependencies } from "../src/connection-pool.js";
import {
  connectBoundedProjectDatabase,
  createProjectDatabaseService,
  type ProjectDatabaseClient,
} from "../src/service.js";
import type { DatabaseBindingScope } from "../src/registry.js";

it("absorbs late backend errors throughout forced pooled termination and discards rejected cleanup", async () => {
  const db = await startTestPostgres();
  const pool = new Pool({ ...db.pool.options, max: 1 });
  pool.on("error", () => undefined);
  let active: ProjectDatabaseClient | undefined;
  try {
    await db.pool.query("CREATE TABLE pool_termination_writes(value int)");
    for (const rejectEnd of [false, true]) {
      let leased: PoolClient | undefined;
      pool.once("acquire", (client: PoolClient) => {
        leased = client;
      });
      const client = pooledClientDependencies(pool).createClient({});
      active = client;
      const applicationError = vi.fn();
      client.on?.("error", applicationError);
      await client.connect();
      await client.query({ text: "BEGIN", values: [] });
      await client.query({ text: "INSERT INTO pool_termination_writes VALUES(1)", values: [] });
      const backend = await client.query({ text: "SELECT pg_backend_pid() AS pid", values: [] });
      if (!leased) throw new Error("Expected a real leased PostgreSQL client");
      const held = leased as PoolClient & { end(): Promise<void> };
      const release = vi.spyOn(held, "release");
      const realEnd = held.end.bind(held);
      let resumeEnd!: () => void;
      const paused = new Promise<void>((resolve) => {
        resumeEnd = resolve;
      });
      // Only defer transport completion; acquisition, transactions and pool release remain real.
      vi.spyOn(held, "end").mockImplementationOnce(async () => {
        await paused;
        if (rejectEnd) throw new Error("simulated cleanup failure");
        await realEnd();
      });
      const ending = client.terminate?.();
      const outcome = rejectEnd
        ? expect(ending).rejects.toThrow("simulated cleanup failure")
        : expect(ending).resolves.toBeUndefined();
      try {
        expect(release).not.toHaveBeenCalled();
        expect(() =>
          held.emit(
            "error",
            Object.assign(new Error("terminating connection due to idle-in-transaction timeout"), {
              severity: "FATAL",
              code: "25P03",
            }),
          ),
        ).not.toThrow();
        expect(applicationError).not.toHaveBeenCalled();
      } finally {
        resumeEnd();
        await outcome;
      }
      expect(release).toHaveBeenCalledExactlyOnceWith(true);
      expect(held.listeners("error")).not.toContain(applicationError);
      await client.terminate?.();
      await expect(client.query({ text: "SELECT 1", values: [] })).rejects.toThrow(
        "project_database_connection_closed",
      );
      const replacement = await pool.query("SELECT pg_backend_pid() AS pid");
      expect(replacement.rows).not.toEqual(backend.rows);
      expect((await db.pool.query("SELECT * FROM pool_termination_writes")).rows).toEqual([]);
    }
  } finally {
    await active?.terminate?.();
    await pool.end();
    await db.stop();
  }
});

it("guards raw leased clients against late backend errors while a database lane is invalidated", async () => {
  const db = await startTestPostgres();
  const uri = new URL(db.pool.options.connectionString as string);
  uri.password = "local-test-password";
  uri.searchParams.set("sslmode", "verify-full");
  const pool = new DatabaseLanePool(uri.href, 1);
  // This isolated transport does not serve TLS; the existing test below verifies the real TLS lane.
  pool.options.port = Number(uri.port);
  pool.options.ssl = false;
  let resumeEnd!: () => void;
  try {
    const client = (await pool.connect()) as PoolClient & { end(): Promise<void> };
    await client.query("BEGIN");
    const realEnd = client.end.bind(client);
    const release = vi.spyOn(client, "release");
    const paused = new Promise<void>((resolve) => {
      resumeEnd = resolve;
    });
    vi.spyOn(client, "end").mockImplementationOnce(async () => {
      await paused;
      await realEnd();
    });
    const invalidating = pool.invalidate();
    try {
      expect(release).not.toHaveBeenCalled();
      expect(() => client.emit("error", new Error("late backend termination"))).not.toThrow();
    } finally {
      resumeEnd();
      await invalidating;
    }
    expect(release).toHaveBeenCalledExactlyOnceWith(true);
    await expect(pool.connect()).rejects.toThrow("No held database connection");
  } finally {
    resumeEnd?.();
    await pool.invalidate();
    await db.stop();
  }
});

it("reuses verified TLS sockets, bounds queues, and interrupts held and queued work on revocation", async () => {
  const db = await startTestPostgres();
  let pool: DatabaseLanePool | undefined;
  let successorAuth: DatabaseLanePool | undefined;
  try {
    const directory = String(
      (await db.pool.query("SHOW data_directory")).rows[0]?.["data_directory"],
    );
    if (!directory.includes("ohmyhost-control-api-postgres-"))
      throw new Error("TLS acceptance requires an isolated local temporary PostgreSQL cluster");
    const cert = resolve(directory, "runtime-test.crt");
    const key = resolve(directory, "runtime-test.key");
    await promisify(execFile)("openssl", [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-keyout",
      key,
      "-out",
      cert,
      "-nodes",
      "-days",
      "1",
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=DNS:localhost,IP:127.0.0.1",
    ]);
    await chmod(key, 0o600);
    await db.pool.query(`ALTER SYSTEM SET ssl_cert_file = '${cert.replaceAll("'", "''")}'`);
    await db.pool.query(`ALTER SYSTEM SET ssl_key_file = '${key.replaceAll("'", "''")}'`);
    await db.pool.query("ALTER SYSTEM SET ssl = 'on'");
    await db.pool.query("SELECT pg_reload_conf()");
    for (let attempt = 0; attempt < 50; attempt += 1) {
      if ((await db.pool.query("SHOW ssl")).rows[0]?.["ssl"] === "on") break;
      await new Promise((done) => setTimeout(done, 20));
    }
    const uri = new URL(db.pool.options.connectionString as string);
    uri.password = "local-test-password";
    uri.searchParams.set("sslmode", "verify-full");
    pool = new DatabaseLanePool(uri.href, 1);
    pool.options.port = Number(uri.port);
    // Trust only this test server's generated CA; production always uses the runtime CA store.
    pool.options.ssl = {
      rejectUnauthorized: true,
      servername: "localhost",
      ca: await readFile(cert, "utf8"),
    };
    const lane = pool;
    const dependencies = pooledClientDependencies(pool);
    const service = createProjectDatabaseService(uri.href, dependencies);
    const statement = {
      text: "SELECT pg_backend_pid() AS pid, ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()",
      values: [],
    };
    const first = await service.query(statement);
    const second = await service.query(statement);
    expect(first).toEqual(second);
    expect(first).toMatchObject({ rows: [{ ssl: true }] });
    const firstPid = "rows" in first ? first.rows[0]?.["pid"] : undefined;
    await db.pool.query("SELECT pg_terminate_backend($1)", [firstPid]);
    for (let attempt = 0; attempt < 50 && lane.totalCount > 0; attempt += 1)
      await new Promise((done) => setTimeout(done, 20));
    expect(await service.query(statement)).not.toEqual(first);
    const abortable = await connectBoundedProjectDatabase(uri.href, dependencies, 776);
    await abortable.query({ text: "BEGIN", values: [] });
    await abortable.abort();
    await abortable.abort();
    await expect(abortable.query({ text: "SELECT 1", values: [] })).rejects.toThrow();
    const untrusted = new DatabaseLanePool(uri.href, 1);
    untrusted.options.port = Number(uri.port);
    untrusted.options.ssl = { rejectUnauthorized: true, servername: "localhost" };
    await expect(untrusted.connect()).rejects.toThrow();
    await untrusted.invalidate();
    await expect(service.query({ text: "SELECT 1; SELECT 2", values: [] })).rejects.toMatchObject({
      code: "42601",
    });
    const connection = await connectBoundedProjectDatabase(uri.href, dependencies, 777);
    await connection.query({ text: "BEGIN", values: [] });
    const queued = Array.from({ length: 32 }, () =>
      lane.connect().then(
        () => "unexpected",
        () => "denied",
      ),
    );
    await expect(pool.connect()).rejects.toThrow("No held database connection");
    await pool.invalidate();
    await pool.invalidate();
    expect(await Promise.all(queued)).toEqual(Array.from({ length: 32 }, () => "denied"));
    await expect(connection.query({ text: "SELECT 1", values: [] })).rejects.toThrow();
    await expect(connection.close()).rejects.toThrow("Client was closed");
    await expect(pool.connect()).rejects.toThrow();
    await new Promise<void>((resolve) =>
      lane.connect((error, client, done) => {
        expect(error).toBeInstanceOf(Error);
        expect(client).toBeUndefined();
        done();
        resolve();
      }),
    );

    const localPool = new DatabaseLanePool(uri.href, 2);
    localPool.options.port = Number(uri.port);
    localPool.options.ssl = {
      rejectUnauthorized: true,
      servername: "localhost",
      ca: await readFile(cert, "utf8"),
    };
    pool = localPool;
    const queryLane = new DatabaseLanePool(uri.href, 1);
    queryLane.options.port = Number(uri.port);
    queryLane.options.ssl = localPool.options.ssl;
    const authLane = new DatabaseLanePool(uri.href, 2);
    authLane.options.port = Number(uri.port);
    authLane.options.ssl = localPool.options.ssl;
    await db.pool.query(
      await readFile(
        new URL(
          "../../../packages/customer-auth-better-auth/migrations/20260822000000_better_auth.sql",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    await new Promise<void>((resolve, reject) =>
      localPool.connect((error, client, done) => {
        if (error) {
          reject(error);
          return;
        }
        expect(client).toBeDefined();
        done();
        resolve();
      }),
    );
    const organizationId = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
    const projectId = "01ARZ3NDEKTSV4RRFFQ69G5FAW";
    const environmentId = "01ARZ3NDEKTSV4RRFFQ69G5FAX";
    const prodId = "01ARZ3NDEKTSV4RRFFQ69G5FAZ";
    const physical = {
      organizationId,
      projectId,
      physicalEnvironmentId: environmentId,
      region: "us" as const,
    };
    const scope = { ...physical, environmentId, registrationVersion: 1 };
    let stored: unknown;
    const object = new ProjectDatabaseEnvironment(
      {
        storage: {
          async get<T>() {
            return stored as T | undefined;
          },
          async put(_key: string, value: unknown) {
            stored = value;
          },
        },
      },
      {
        DATABASE_REGION: "us",
        DATABASE_REGISTRY_KEY: btoa("k".repeat(32)),
        DATABASE_ENVIRONMENTS: {} as never,
        OHMYHOST_MAIL_GATEWAY: { fetch: async () => new Response(null, { status: 202 }) },
      },
    );
    const registration = {
      ...physical,
      operationId: "01ARZ3NDEKTSV4RRFFQ69G5FAY",
      registrationVersion: 1,
      providerProjectId: "project-test",
      branchId: "br-test",
      originHost: "ep-test-pooler.us-east-1.aws.neon.tech",
      originDatabase: "neondb",
      originUser: `ohmyho_rw_${environmentId.toLowerCase()}`,
      authorizedEnvironmentIds: [environmentId, prodId],
      pooledConnectionString: `postgresql://ohmyho_rw_${environmentId.toLowerCase()}:test-password@ep-test-pooler.us-east-1.aws.neon.tech/neondb?sslmode=require`,
    };
    await object.register(registration);
    // The provider test adapter supplies real local TLS pools instead of contacting Neon;
    // production registry validation and all public runtime operations remain unchanged.
    Object.assign(object, { pools: { query: queryLane, transaction: localPool, auth: authLane } });
    expect(await object.query(scope, { text: "SELECT 7 AS value", values: [] })).toMatchObject({
      rows: [{ value: 7 }],
    });
    const occupiedQueryLane = await queryLane.connect();
    try {
      const result = await Promise.race([
        object.transaction(scope, [{ text: "SELECT 8 AS value", values: [] }]),
        new Promise<"query_lane_blocked">((resolve) =>
          setTimeout(() => resolve("query_lane_blocked"), 1_000),
        ),
      ]);
      expect(result).toMatchObject([{ rows: [{ value: 8 }] }]);
    } finally {
      occupiedQueryLane.release();
    }
    expect(
      await object.transaction(scope, [{ text: "SELECT 8 AS value", values: [] }]),
    ).toMatchObject([{ rows: [{ value: 8 }] }]);
    const held = await object.open(scope);
    expect(await held.query({ text: "SELECT 9 AS value", values: [] })).toMatchObject({
      rows: [{ value: 9 }],
    });
    await held.close();
    const interrupted = await object.open(scope);
    await interrupted.query({ text: "BEGIN", values: [] });
    const prodScope = { ...scope, environmentId: prodId };
    const surviving = await object.open(prodScope);
    await surviving.query({ text: "BEGIN", values: [] });
    await surviving.query({ text: "CREATE TEMP TABLE prod_survives(n int)", values: [] });
    await surviving.query({ text: "INSERT INTO prod_survives VALUES(42)", values: [] });
    const authRequest = () =>
      new Request("https://internal/api/auth/request-password-reset", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://scope-test.example.com",
          "cf-connecting-ip": "192.0.2.101",
          "x-ohmyhost-project-id": projectId,
          "x-ohmyhost-auth-url": "https://scope-test.example.com",
          "x-ohmyhost-auth-secret": "local-authentication-test-secret-with-scope-boundary",
          "x-ohmyhost-mail-key": "local-auth-mail-key",
          "x-ohmyhost-app-name": "Scope boundary",
        },
        body: JSON.stringify({ email: "absent@scope-test.example.com" }),
      });
    const internals = object as unknown as {
      resources(binding: DatabaseBindingScope): Promise<{
        uri: string;
        pools: { query: DatabaseLanePool; transaction: DatabaseLanePool; auth: DatabaseLanePool };
      }>;
      pools: { query: DatabaseLanePool; transaction: DatabaseLanePool; auth: DatabaseLanePool };
    };
    const originalResources = internals.resources.bind(object);
    let authReached!: () => void;
    const reached = new Promise<void>((resolve) => (authReached = resolve));
    let resumeAuth!: () => void;
    const paused = new Promise<void>((resolve) => (resumeAuth = resolve));
    // Delay only the scheduling boundary: registry crypto, Better Auth, Kysely and pg remain real.
    const heldResources = vi
      .spyOn(internals, "resources")
      .mockImplementationOnce(async (binding) => {
        const resources = await originalResources(binding);
        authReached();
        await paused;
        return resources;
      });
    const heldAuth = object.authenticate(scope, authRequest());
    await reached;
    const pendingDev = object.query(scope, { text: "SELECT pg_sleep(30)", values: [] }).then(
      // An interrupted statement may already have written, so its outcome is reported as unknown
      // (08007), never as a plain failure that a caller could replay.
      (result) =>
        (result as { type?: string; sqlstate?: string }).type === "ohmyhost.database-error/v1" &&
        (result as { sqlstate?: string }).sqlstate === "08007"
          ? "denied"
          : "unexpected",
      () => "denied",
    );
    for (let attempt = 0; attempt < 50; attempt += 1) {
      if (
        Number(
          (
            await db.pool.query(
              "SELECT count(*) n FROM pg_stat_activity WHERE query='SELECT pg_sleep(30)' AND state='active'",
            )
          ).rows[0]?.["n"],
        ) === 1
      )
        break;
      await new Promise((done) => setTimeout(done, 20));
    }
    await object.register({
      ...registration,
      registrationVersion: 2,
      authorizedEnvironmentIds: [prodId],
    });
    successorAuth = internals.pools.auth;
    // The new lane uses the real test TLS endpoint; no external provider is contacted.
    Object.assign(successorAuth.options, authLane.options);
    const authBorrow = vi.spyOn(successorAuth, "connect");
    try {
      expect((await object.authenticate(prodScope, authRequest())).status).toBe(200);
      expect(authBorrow.mock.calls.length).toBeGreaterThan(0);
      expect((await object.authenticate(scope, authRequest())).status).toBe(503);
    } finally {
      heldResources.mockRestore();
      resumeAuth();
    }
    const borrowedByProd = authBorrow.mock.calls.length;
    expect((await heldAuth).status).toBe(503);
    expect(authBorrow.mock.calls).toHaveLength(borrowedByProd);
    authBorrow.mockRestore();
    await expect(authLane.connect()).rejects.toThrow();
    expect(await pendingDev).toBe("denied");
    await expect(interrupted.query({ text: "SELECT 1", values: [] })).rejects.toThrow();
    expect(
      await surviving.query({ text: "SELECT n FROM prod_survives", values: [] }),
    ).toMatchObject({ rows: [{ n: 42 }] });
    await surviving.query({ text: "COMMIT", values: [] });
    await object.register({ ...registration, registrationVersion: 3 });
    await expect(object.query(scope, { text: "SELECT 1", values: [] })).rejects.toThrow();
    expect(
      await object.query(
        { ...scope, registrationVersion: 3 },
        { text: "SELECT 10 AS value", values: [] },
      ),
    ).toMatchObject({ rows: [{ value: 10 }] });
    await surviving.close();
    expect(
      (
        await object.authenticate(
          { ...scope, registrationVersion: 3 },
          new Request("https://internal/not-auth"),
        )
      ).status,
    ).toBe(404);
    await object.revoke({
      ...physical,
      operationId: "01ARZ3NDEKTSV4RRFFQ69G5FAZ",
      registrationVersion: 4,
    });
    await expect(interrupted.query({ text: "SELECT 1", values: [] })).rejects.toThrow(
      "project_database_connection_query_failed",
    );
    await interrupted.close();
  } finally {
    await pool?.invalidate();
    await successorAuth?.invalidate();
    await db.stop();
  }
});

it("returns a pooled session to the platform statement timeout when a query changed it before the session was released", async () => {
  const db = await startTestPostgres();
  const pool = new Pool({ ...db.pool.options, max: 1, statement_timeout: 10_000 });
  pool.on("error", () => undefined);
  try {
    const first = pooledClientDependencies(pool).createClient({});
    await first.connect();
    await first.query({ text: "SET statement_timeout = 0", values: [] });
    await first.query({ text: "SET transaction_timeout = 0", values: [] });
    await first.end();

    const second = pooledClientDependencies(pool).createClient({});
    await second.connect();
    const timeouts = await second.query({
      text: "SELECT current_setting('statement_timeout') AS statement, current_setting('transaction_timeout') AS transaction",
      values: [],
    });
    await second.end();
    expect(timeouts.rows).toEqual([{ statement: "10s", transaction: "0" }]);
  } finally {
    await pool.end();
    await db.stop();
  }
}, 60_000);

it("keeps absorbing late backend errors on a session destroyed because it could not be reset", async () => {
  const db = await startTestPostgres();
  const pool = new Pool({ ...db.pool.options, max: 1, statement_timeout: 10_000 });
  pool.on("error", () => undefined);
  let leased: PoolClient | undefined;
  pool.once("acquire", (client: PoolClient) => {
    leased = client;
  });
  try {
    const client = pooledClientDependencies(pool).createClient({});
    await client.connect();
    if (!leased) throw new Error("Expected a real leased PostgreSQL client");
    const held = leased;
    // Only the reset fails; the session is then destroyed and must still absorb what its backend reports afterwards.
    const realQuery = held.query.bind(held) as (...args: unknown[]) => unknown;
    vi.spyOn(held, "query").mockImplementation(((...args: unknown[]) =>
      args[0] === "RESET ALL"
        ? Promise.reject(new Error("simulated reset failure"))
        : realQuery(...args)) as typeof held.query);
    await client.end();
    expect(() =>
      held.emit(
        "error",
        Object.assign(new Error("terminating connection due to administrator command"), {
          severity: "FATAL",
          code: "57P01",
        }),
      ),
    ).not.toThrow();
  } finally {
    await pool.end();
    await db.stop();
  }
}, 60_000);
