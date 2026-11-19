import { expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
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
import { startTestPostgres } from "../../control-api/test/postgres.js";
import { DatabaseLanePool } from "../src/connection-pool.js";
import { ProjectDatabaseRlsError } from "../src/service.js";
import {
  ProjectDatabaseEnvironment,
  ProjectDatabaseRlsConnection,
  ProjectDatabaseService,
} from "../src/worker-service.js";

it("keeps RLS RPC bound to its logical environment, revokes queued work, and aborts abandoned targets", async () => {
  const db = await startTestPostgres();
  const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const uri = new URL(db.pool.options.connectionString as string);
  uri.password = "isolated-test-password";
  uri.searchParams.set("sslmode", "verify-full");
  const lanes: DatabaseLanePool[] = [];
  const lane = (maximum: number) => {
    const pool = new DatabaseLanePool(uri.href, maximum);
    // Only this fixture uses the disposable local server. The production registry, scope
    // validation, bounded clients and revocation machinery all remain in the exercised path.
    Object.assign(pool.options, {
      port: Number(uri.port),
      ssl: false,
      options: db.pool.options.options,
    });
    lanes.push(pool);
    return pool;
  };
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
  let stored: unknown;
  const env = {
    DATABASE_REGION: "us" as const,
    DATABASE_REGISTRY_KEY: btoa("k".repeat(32)),
    DATABASE_ENVIRONMENTS: {
      jurisdiction() {
        return this;
      },
      getByName() {
        return object;
      },
    },
    OHMYHOST_MAIL_GATEWAY: { fetch: async () => new Response(null, { status: 202 }) },
  };
  const object = new ProjectDatabaseEnvironment(
    {
      storage: {
        async get<T>() {
          return stored as T | undefined;
        },
        async put(_key: string, value: unknown) {
          stored = structuredClone(value);
        },
      },
    },
    env,
  );
  try {
    await db.pool.query("CREATE TABLE rls_worker_writes(value int)");
    await object.register(registration);
    const transaction = lane(2);
    Object.assign(object, { pools: { query: lane(1), transaction, auth: lane(2) } });
    const dev = new ProjectDatabaseService({ props: scope }, env);
    const prod = new ProjectDatabaseService({ props: { ...scope, environmentId: prodId } }, env);
    const foreign = new ProjectDatabaseService({ props: { ...scope, projectId: prodId } }, env);
    await expect(foreign.openRls({ subject: "alice" })).rejects.toThrow(
      "project_database_open_failed",
    );
    await expect(dev.openRls({ subject: "alice", claims: { sub: "forged" } })).rejects.toThrow(
      "project_database_open_failed",
    );
    const limited = await dev.openRls(null);
    expect(await limited.query({ text: "SELECT 1; COMMIT", values: [] })).toEqual({
      type: "ohmyhost.database-error/v1",
      sqlstate: "42601",
    });
    expect(await limited.commit()).toEqual({
      type: "ohmyhost.database-rls-error/v1",
      code: "database_rls_transaction_failed",
    });
    await limited.close();
    const interrupted = await dev.openRls({ subject: "alice" });
    const surviving = await prod.openRls({ subject: "bob" });
    await interrupted.query({ text: "INSERT INTO rls_worker_writes VALUES(1)", values: [] });
    await surviving.query({ text: "INSERT INTO rls_worker_writes VALUES(2)", values: [] });
    const queued = dev.openRls({ subject: "alice" }).then(
      () => "unexpected",
      () => "denied",
    );
    for (let attempt = 0; attempt < 50 && transaction.waitingCount === 0; attempt += 1)
      await new Promise((resolve) => setTimeout(resolve, 10));
    expect(transaction.waitingCount).toBe(1);
    await object.register({
      ...registration,
      registrationVersion: 2,
      authorizedEnvironmentIds: [prodId],
    });
    const internals = object as unknown as { pools: { auth: DatabaseLanePool } };
    lanes.push(internals.pools.auth);
    expect(await queued).toBe("denied");
    expect(await interrupted.commit()).toEqual({
      type: "ohmyhost.database-rls-error/v1",
      code: "database_rls_transaction_failed",
    });
    expect(
      await surviving.query({
        text: "SELECT current_setting('ohmyhost.request_claims')::jsonb->>'sub' AS subject",
        values: [],
      }),
    ).toMatchObject({ rows: [{ subject: "bob" }] });
    expect(await surviving.commit()).toEqual({ type: "ohmyhost.database-rls-commit/v1" });
    expect((await db.pool.query("SELECT value FROM rls_worker_writes")).rows).toEqual([
      { value: 2 },
    ]);

    const credentials = await prod.openRls({ subject: "bob" });
    await credentials.query({ text: "INSERT INTO rls_worker_writes VALUES(3)", values: [] });
    await object.register({
      ...registration,
      registrationVersion: 3,
      authorizedEnvironmentIds: [prodId],
      pooledConnectionString: registration.pooledConnectionString.replace(
        "test-password",
        "successor-password",
      ),
    });
    expect(await credentials.query({ text: "SELECT 1", values: [] })).toEqual({
      type: "ohmyhost.database-rls-error/v1",
      code: "database_rls_transaction_failed",
    });
    expect(await credentials.commit()).toEqual({
      type: "ohmyhost.database-rls-error/v1",
      code: "database_rls_transaction_failed",
    });
    expect((await db.pool.query("SELECT value FROM rls_worker_writes")).rows).toEqual([
      { value: 2 },
    ]);
    expect(JSON.stringify(logged.mock.calls)).not.toContain("test-password");
    const directory = await mkdtemp(join(tmpdir(), "ohmyhost-rls-worker-proof-"));
    let runtime: Miniflare | undefined;
    try {
      await promisify(execFile)(
        "pnpm",
        [
          "exec",
          "wrangler",
          "deploy",
          "test/fixtures/socket-worker.ts",
          "--dry-run",
          "--outdir",
          directory,
          "--config",
          "wrangler.jsonc",
          "--env-file",
          "/dev/null",
        ],
        { cwd: fileURLToPath(new URL("../", import.meta.url)) },
      );
      runtime = new Miniflare(
        convertV4MiniflareOptions({
          name: "rls-socket-proof",
          cf: false,
          compatibilityDate: "2026-08-24",
          compatibilityFlags: ["nodejs_compat"],
          modules: [
            {
              type: "ESModule",
              path: fileURLToPath(new URL("./rls-socket-proof.mjs", import.meta.url)),
              contents: await readFile(join(directory, "socket-worker.js"), "utf8"),
            },
          ],
          durableObjects: {
            DATABASE_ENVIRONMENTS: { className: "ProjectDatabaseEnvironment", useSQLite: true },
            SCOPE_ENVIRONMENTS: { className: "ScopedDatabaseEnvironment", useSQLite: true },
          },
          bindings: { TEST_DATABASE_URI: uri.href },
        }),
      );
      const success = await runtime.dispatchFetch("https://test.invalid/rls");
      expect(success.status).toBe(200);
      expect(await success.json()).toMatchObject({
        result: { rows: [{ claims: { sub: "alice", role: "authenticated", team: "green" } }] },
        commit: { type: "ohmyhost.database-rls-commit/v1" },
      });
      const failure = await runtime.dispatchFetch("https://test.invalid/rls-invalid");
      expect(failure.status).toBe(200);
      expect(await failure.json()).toEqual({
        result: { type: "ohmyhost.database-error/v1", sqlstate: "54000" },
        commit: { type: "ohmyhost.database-rls-error/v1", code: "database_rls_transaction_failed" },
      });
      await runtime.dispatchFetch("https://test.invalid/close");
    } finally {
      await runtime?.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  } finally {
    await Promise.all(lanes.map((pool) => pool.invalidate()));
    await db.stop();
    logged.mockRestore();
  }

  vi.useFakeTimers();
  let aborted = 0;
  let released = 0;
  const connection = {
    async query() {
      return { command: "SELECT", rows: [], rowCount: 0 };
    },
    async commit() {},
    async close() {},
    async abort() {
      aborted += 1;
    },
  };
  const target = () =>
    new ProjectDatabaseRlsConnection(connection, () => {
      released += 1;
    });
  try {
    let finishQuery!: () => void;
    let finishCommit!: () => void;
    const active = new ProjectDatabaseRlsConnection(
      {
        ...connection,
        query: () =>
          new Promise<void>((resolve) => {
            finishQuery = resolve;
          }),
        commit: () =>
          new Promise<void>((resolve) => {
            finishCommit = resolve;
          }),
      },
      () => undefined,
    );
    const query = active.query({});
    const commit = active.commit();
    finishQuery();
    await query;
    await vi.advanceTimersByTimeAsync(6_000);
    expect(aborted).toBe(0);
    finishCommit();
    expect(await commit).toEqual({ type: "ohmyhost.database-rls-commit/v1" });
    await active.close();
    const uncertain = new ProjectDatabaseRlsConnection(
      {
        ...connection,
        async commit() {
          throw new ProjectDatabaseRlsError("database_transaction_outcome_unknown");
        },
      },
      () => undefined,
    );
    expect(await uncertain.commit()).toMatchObject({
      code: "database_transaction_outcome_unknown",
    });
    expect(await uncertain.commit()).toMatchObject({
      code: "database_transaction_outcome_unknown",
    });
    const idle = target();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(aborted).toBe(1);
    expect(await idle.commit()).toMatchObject({ code: "database_rls_transaction_failed" });
    await idle.close();
    idle[Symbol.dispose]();
    const lifetime = target();
    for (let count = 0; count < 7; count += 1) {
      await vi.advanceTimersByTimeAsync(4_000);
      await lifetime.query({});
    }
    await vi.advanceTimersByTimeAsync(2_000);
    expect(aborted).toBe(2);
    const disposed = target();
    disposed[Symbol.dispose]();
    await vi.advanceTimersByTimeAsync(1);
    expect(aborted).toBe(3);
    expect(released).toBe(3);
    const closed = target();
    await closed.close();
    await closed.close();
    expect(released).toBe(4);
  } finally {
    vi.useRealTimers();
    logged.mockRestore();
  }
}, 60_000);
