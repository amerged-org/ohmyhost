import { connect, type Socket } from "node:net";
import { readFile, writeFile } from "node:fs/promises";
import { expect, it, vi } from "vitest";
import { startTestPostgres } from "../../control-api/test/postgres.js";
import { DatabaseLanePool } from "../src/connection-pool.js";

const errorResponse = (code: string, message: string) => {
  const fields = Buffer.concat(
    [
      ["S", "FATAL"],
      ["V", "FATAL"],
      ["C", code],
      ["M", message],
    ].map(([tag, text]) => Buffer.from(`${tag}${text}\0`)),
  );
  const header = Buffer.alloc(5);
  header.write("E");
  header.writeInt32BE(4 + fields.length + 1, 1);
  return Uint8Array.from(Buffer.concat([header, fields, Buffer.from([0])]));
};

it("retries the connection of a PGCF database that refuses it while going to sleep or waking, before any SQL", async () => {
  const db = await startTestPostgres();
  const upstream = new URL(db.pool.options.connectionString as string);
  const target = {
    provider: "pgcf" as const,
    host: "sql.pgcf.example",
    databaseId: "d1234567890123456789",
    role: "omh_pgcf_fixture",
  };
  const refusals = ["08006", "53300", "57P03"];
  const sockets = new Set<Socket>();
  let attempts = 0;
  let sql = 0;
  let pool: DatabaseLanePool | undefined;
  let hbaPath: string | undefined;
  let hba: string | undefined;
  try {
    await db.pool.query("CREATE ROLE omh_pgcf_fixture LOGIN PASSWORD 'fixture-password'");
    await db.pool.query(`CREATE DATABASE ${target.databaseId} OWNER omh_pgcf_fixture`);
    hbaPath = String((await db.pool.query("SHOW hba_file")).rows[0]?.["hba_file"]);
    hba = await readFile(hbaPath, "utf8");
    await writeFile(
      hbaPath,
      `host ${target.databaseId} omh_pgcf_fixture 127.0.0.1/32 password\n${hba}`,
    );
    await db.pool.query("SELECT pg_reload_conf()");
    await new Promise((resolve) => setTimeout(resolve, 50));

    class GatewayWebSocket extends EventTarget {
      public binaryType = "arraybuffer";
      private readonly refusal = refusals[attempts++];
      private socket: Socket | undefined;
      public constructor() {
        super();
        if (this.refusal === undefined) {
          this.socket = connect(Number(upstream.port), "127.0.0.1");
          sockets.add(this.socket);
          this.socket.on("data", (bytes) =>
            this.dispatchEvent(
              new MessageEvent("message", { data: Uint8Array.from(bytes).buffer }),
            ),
          );
          this.socket.on("error", () => this.dispatchEvent(new Event("error")));
          this.socket.on("close", () => this.dispatchEvent(new Event("close")));
        }
        queueMicrotask(() => this.dispatchEvent(new Event("open")));
      }
      public send(bytes: Uint8Array) {
        if (this.socket === undefined) {
          // The gateway answers the startup message with the refusal and closes.
          setTimeout(() => {
            this.dispatchEvent(
              new MessageEvent("message", {
                data: errorResponse(
                  String(this.refusal),
                  "the database is not accepting connections",
                ).buffer,
              }),
            );
            this.dispatchEvent(new Event("close"));
          }, 0);
          return;
        }
        if (new TextDecoder().decode(bytes).includes("SELECT 1 AS woke")) sql += 1;
        this.socket.write(bytes);
      }
      public close() {
        this.socket?.end();
      }
    }
    vi.stubGlobal("WebSocket", GatewayWebSocket);
    pool = new DatabaseLanePool(
      `postgres://${target.role}:fixture-password@${target.host}/${target.databaseId}`,
      1,
      target,
    );
    expect((await pool.query("SELECT 1 AS woke")).rows).toEqual([{ woke: 1 }]);
    // Three refusals and one accepted connection; the statement ran exactly once.
    expect(attempts).toBe(4);
    expect(sql).toBe(1);
  } finally {
    await pool?.invalidate();
    for (const socket of sockets) socket.destroy();
    vi.unstubAllGlobals();
    if (hbaPath !== undefined && hba !== undefined) await writeFile(hbaPath, hba);
    await db.stop();
  }
}, 30_000);
