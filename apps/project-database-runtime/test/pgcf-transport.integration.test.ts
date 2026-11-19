import { connect, type Socket } from "node:net";
import type { PoolClient } from "pg";
import { readFile, writeFile } from "node:fs/promises";
import { expect, it, vi } from "vitest";
import { startTestPostgres } from "../../control-api/test/postgres.js";
import { productionPgcfDataConnection } from "../../neon-management/src/pgcf-data-operations.js";
import { pgcfManagementConnect } from "../../neon-management/src/provider-runtime.js";
import { CustomerDatabaseError } from "../../../packages/customer-runtime/src/errors.js";
import { DatabaseLanePool, pooledClientDependencies } from "../src/connection-pool.js";
import {
  connectRlsProjectDatabase,
  createProjectDatabaseService,
  ProjectDatabaseOutcomeUnknownError,
  type ProjectDatabaseClient,
} from "../src/service.js";

async function inTransaction(
  pool: DatabaseLanePool,
  work: (client: PoolClient) => Promise<unknown>,
) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await work(client);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

it("uses the scoped WSS client for real transactions and transaction-local RLS without a TCP or HTTP fallback", async () => {
  const db = await startTestPostgres();
  const upstream = new URL(db.pool.options.connectionString as string);
  const target = {
    provider: "pgcf" as const,
    host: "sql.pgcf.example",
    databaseId: "d1234567890123456789",
    role: "omh_pgcf_fixture",
  };
  const requests: string[] = [];
  const sockets = new Set<Socket>();
  const startupTimers = new Set<ReturnType<typeof setTimeout>>();
  let prematureBusinessWrites = 0;
  let pool: DatabaseLanePool | undefined;
  let hbaPath: string | undefined;
  let hba: string | undefined;
  const fetcher = vi.fn(() => Promise.reject(new Error("Unexpected HTTP fallback")));
  try {
    const directory = String(
      (await db.pool.query("SHOW data_directory")).rows[0]?.["data_directory"],
    );
    if (
      !directory.includes("ohmyhost-control-api-postgres-") ||
      upstream.hostname !== "127.0.0.1"
    ) {
      throw new Error("The WSS transport regression requires an isolated local PostgreSQL cluster");
    }
    await db.pool.query("CREATE ROLE omh_pgcf_fixture LOGIN PASSWORD 'fixture-password'");
    await db.pool.query(`CREATE DATABASE ${target.databaseId} OWNER omh_pgcf_fixture`);
    hbaPath = String((await db.pool.query("SHOW hba_file")).rows[0]?.["hba_file"]);
    hba = await readFile(hbaPath, "utf8");
    // Match the gateway's cleartext challenge inside its secure WSS channel. Only this isolated
    // test loopback hop is plaintext; production has no public PostgreSQL TCP origin.
    await writeFile(
      hbaPath,
      `host ${target.databaseId} omh_pgcf_fixture 127.0.0.1/32 password\n${hba}`,
    );
    await db.pool.query("SELECT pg_reload_conf()");
    await new Promise((resolve) => setTimeout(resolve, 50));

    class LoopbackWebSocket extends EventTarget {
      public binaryType = "arraybuffer";
      private readonly socket: Socket;
      private startupReady = false;
      public constructor(url: string) {
        super();
        requests.push(url);
        this.socket = connect(Number(upstream.port), "127.0.0.1");
        sockets.add(this.socket);
        const cold = requests.length === 1;
        this.socket.pause();
        this.socket.on("connect", () => {
          // Accept the WebSocket while the backend's actual authentication reply is still pending.
          this.dispatchEvent(new Event("open"));
          const timer = setTimeout(
            () => {
              startupTimers.delete(timer);
              this.startupReady = true;
              this.socket.resume();
            },
            cold ? 13_000 : 0,
          );
          startupTimers.add(timer);
        });
        this.socket.on("data", (bytes) =>
          this.dispatchEvent(new MessageEvent("message", { data: Uint8Array.from(bytes).buffer })),
        );
        this.socket.on("error", () => this.dispatchEvent(new Event("error")));
        this.socket.on("close", () => {
          sockets.delete(this.socket);
          this.dispatchEvent(new Event("close"));
        });
      }
      public send(bytes: Uint8Array) {
        if (!this.startupReady && new TextDecoder().decode(bytes).includes("CREATE TABLE notes"))
          prematureBusinessWrites += 1;
        this.socket.write(bytes);
      }
      public close() {
        this.socket.end();
      }
    }
    vi.stubGlobal("WebSocket", LoopbackWebSocket);
    vi.stubGlobal("fetch", fetcher);
    pool = new DatabaseLanePool(
      `postgres://${target.role}:fixture-password@${target.host}/${target.databaseId}`,
      2,
      target,
    );
    expect(pool.options.connectionTimeoutMillis).toBe(70_000);
    expect(pool.options.statement_timeout).toBe(10_000);
    expect(pool.options.query_timeout).toBe(12_000);
    const coldStartedAt = Date.now();
    await pool.query("CREATE TABLE notes(id int PRIMARY KEY, owner_name text NOT NULL, body text)");
    // Startup exceeded both former connect/query clocks; business SQL starts only after readiness.
    expect(Date.now() - coldStartedAt).toBeGreaterThanOrEqual(13_000);
    expect(prematureBusinessWrites).toBe(0);
    expect(requests).toHaveLength(1);
    await inTransaction(pool, (client) =>
      client.query("INSERT INTO notes VALUES($1,$2,$3)", [1, "alice", "committed"]),
    );
    await expect(
      inTransaction(pool, async (client) => {
        await client.query("INSERT INTO notes VALUES($1,$2,$3)", [2, "alice", "rolled back"]);
        throw new Error("Abort fixture transaction");
      }),
    ).rejects.toThrow("Abort fixture transaction");
    expect((await pool.query("SELECT id FROM notes ORDER BY id")).rows).toEqual([{ id: 1 }]);
    await pool.query("ALTER TABLE notes ENABLE ROW LEVEL SECURITY");
    await pool.query("ALTER TABLE notes FORCE ROW LEVEL SECURITY");
    await pool.query(
      "CREATE POLICY owner_only ON notes USING (owner_name = (current_setting('ohmyhost.request_claims', true)::jsonb->>'sub'))",
    );
    const uri = pool.options.connectionString as string;
    const dependencies = pooledClientDependencies(pool);
    await pool.query("CREATE TABLE effects(marker text)");
    await pool.query(
      "CREATE FUNCTION record_effect() RETURNS void LANGUAGE SQL AS $$ INSERT INTO effects VALUES('select') $$",
    );
    const dispatched: string[] = [];
    const uncertain = createProjectDatabaseService(uri, {
      createClient(configuration): ProjectDatabaseClient {
        const client = dependencies.createClient(configuration);
        return {
          ...client,
          async query(query) {
            dispatched.push(query.text);
            const result = await client.query(query);
            if (query.text === "COMMIT" || query.text === "SELECT record_effect()")
              throw new Error("simulated lost acknowledgement");
            return result;
          },
        };
      },
    });
    for (const operation of [
      () =>
        uncertain.transaction([
          { text: "INSERT INTO effects VALUES($1)", values: ["transaction"] },
        ]),
      () => uncertain.query({ text: "SELECT record_effect()", values: [] }),
    ]) {
      const failure: unknown = await operation().then(
        () => null,
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(ProjectDatabaseOutcomeUnknownError);
      const sqlstate = (failure as ProjectDatabaseOutcomeUnknownError).code as string;
      expect(sqlstate).toBe("08007");
      expect(new CustomerDatabaseError(sqlstate).retryable).toBe(false);
    }
    expect(dispatched.filter((sql) => sql === "COMMIT")).toHaveLength(1);
    expect(dispatched.filter((sql) => sql === "SELECT record_effect()")).toHaveLength(1);
    expect((await pool.query("SELECT marker FROM effects ORDER BY marker")).rows).toEqual([
      { marker: "select" },
      { marker: "transaction" },
    ]);
    const acknowledged = createProjectDatabaseService(uri, {
      createClient(configuration) {
        const client = dependencies.createClient(configuration);
        return {
          ...client,
          async end() {
            await client.end();
            throw new Error("simulated lost disposal acknowledgement");
          },
        };
      },
    });
    await expect(
      acknowledged.transaction([
        { text: "INSERT INTO effects VALUES($1)", values: ["acknowledged"] },
      ]),
    ).resolves.toHaveLength(1);
    expect(
      (await pool.query("SELECT count(*)::int count FROM effects WHERE marker='acknowledged'"))
        .rows,
    ).toEqual([{ count: 1 }]);
    const alice = await connectRlsProjectDatabase(
      uri,
      dependencies,
      456,
      { subject: "alice" },
      async () => undefined,
    );
    expect(await alice.query({ text: "SELECT id FROM notes", values: [] })).toMatchObject({
      rows: [{ id: 1 }],
    });
    await alice.commit();
    const bob = await connectRlsProjectDatabase(
      uri,
      dependencies,
      456,
      { subject: "bob" },
      async () => undefined,
    );
    expect(await bob.query({ text: "SELECT id FROM notes", values: [] })).toMatchObject({
      rows: [],
    });
    await expect(
      bob.query({ text: "INSERT INTO notes VALUES($1,$2,$3)", values: [3, "alice", "forbidden"] }),
    ).rejects.toMatchObject({ code: "42501" });
    await bob.abort();
    const management = await productionPgcfDataConnection(uri, target);
    try {
      expect((await management.client.query("SELECT 1::int AS ready")).rows).toEqual([
        { ready: 1 },
      ]);
    } finally {
      await management.close();
    }
    const provisioning = await pgcfManagementConnect()(uri, target);
    try {
      expect((await provisioning.client.query("SELECT 1::int AS ready")).rows).toEqual([
        { ready: 1 },
      ]);
    } finally {
      await provisioning.close();
    }
    expect(requests.length).toBeGreaterThan(0);
    expect(
      requests.every(
        (url) =>
          url === `wss://${target.host}/v2?database=${target.databaseId}&user=${target.role}`,
      ),
    ).toBe(true);
    expect(fetcher).not.toHaveBeenCalled();
  } finally {
    await pool?.invalidate();
    for (const timer of startupTimers) clearTimeout(timer);
    for (const socket of sockets) socket.destroy();
    vi.unstubAllGlobals();
    if (hbaPath !== undefined && hba !== undefined) await writeFile(hbaPath, hba);
    await db.stop();
  }
}, 30_000);
