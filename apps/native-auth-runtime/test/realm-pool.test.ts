import { connect, type Socket } from "node:net";
import { Client } from "pg";
import { expect, it, vi } from "vitest";
import { startTestPostgres } from "../../control-api/test/postgres.js";
import { createNativeRealmPool } from "../src/realm-pool.js";

it("uses only the registered Native role, schema and PGCF WSS target", async () => {
  const scope = {
    projectId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
    environmentId: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
  };
  const suffix = scope.environmentId.toLowerCase();
  const target = {
    provider: "pgcf" as const,
    host: "sql.pgcf.example",
    databaseId: "d1234567890123456789",
    role: `omh_ar_${suffix}`,
  };
  const registration = {
    schema: `omh_auth_${suffix}`,
    secret: "test-only",
    target,
    connectionString: `postgres://${target.role}:test-only@${target.host}/${target.databaseId}`,
  };
  const pool = createNativeRealmPool(registration, scope);
  expect(pool.options.max).toBe(2);
  expect(pool.options.ssl).toBe(false);
  expect(pool.options.Client?.name).toBe("PgcfClient");
  expect(() => pool.emit("error", new Error("synthetic idle connection failure"))).not.toThrow();
  await pool.end();
  expect(() => createNativeRealmPool({ ...registration, schema: "public" }, scope)).toThrow(
    "auth_unavailable",
  );
  expect(() =>
    createNativeRealmPool({ ...registration, target: { ...target, role: "foreign" } }, scope),
  ).toThrow("auth_unavailable");
  expect(() =>
    createNativeRealmPool(
      {
        ...registration,
        connectionString: `postgres://${target.role}:test-only@other.example/${target.databaseId}`,
      },
      scope,
    ),
  ).toThrow();
});

it("uses the Native role over the PGCF WebSocket client against real PostgreSQL", async () => {
  const db = await startTestPostgres();
  const base = new URL(db.pool.options.connectionString as string);
  const scope = {
    projectId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
    environmentId: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
  };
  const suffix = scope.environmentId.toLowerCase();
  const schema = `omh_auth_${suffix}`;
  const role = `omh_ar_${suffix}`;
  const target = {
    provider: "pgcf" as const,
    host: "sql.pgcf.example",
    databaseId: "d1234567890123456789",
    role,
  };
  const sockets = new Set<Socket>();
  const urls: string[] = [];
  let nativePool: ReturnType<typeof createNativeRealmPool> | undefined;
  try {
    const dataDirectory = String(
      (await db.pool.query("show data_directory")).rows[0]?.["data_directory"],
    );
    if (!dataDirectory.includes("ohmyhost-control-api-postgres-") || base.hostname !== "127.0.0.1")
      throw new Error("isolated_postgres_required");
    await db.pool.query(`create role ${role} login password 'fixture-only'`);
    await db.pool.query(`create database ${target.databaseId} owner ${role}`);
    const bootstrapUrl = new URL(base.href);
    bootstrapUrl.pathname = `/${target.databaseId}`;
    const bootstrap = new Client({ connectionString: bootstrapUrl.href });
    await bootstrap.connect();
    try {
      await bootstrap.query(`create schema ${schema} authorization ${role}`);
    } finally {
      await bootstrap.end();
    }
    class LoopbackWebSocket extends EventTarget {
      public binaryType = "arraybuffer";
      private readonly socket: Socket;
      public constructor(url: string) {
        super();
        urls.push(url);
        this.socket = connect(Number(base.port), "127.0.0.1");
        sockets.add(this.socket);
        this.socket.on("connect", () => this.dispatchEvent(new Event("open")));
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
        this.socket.write(bytes);
      }
      public close() {
        this.socket.end();
      }
    }
    vi.stubGlobal("WebSocket", LoopbackWebSocket);
    nativePool = createNativeRealmPool(
      {
        schema,
        target,
        secret: "fixture",
        connectionString: `postgres://${role}:fixture-only@${target.host}/${target.databaseId}`,
      },
      scope,
    );
    const result = await nativePool.query(
      "select current_user as role, current_schema() as schema",
    );
    expect(result.rows[0]).toMatchObject({ role, schema });
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain("sql.pgcf.example/v2?");
  } finally {
    await nativePool?.end();
    for (const socket of sockets) socket.destroy();
    vi.unstubAllGlobals();
    await db.stop();
  }
}, 30_000);
