import { createServer, connect, type Server, type Socket } from "node:net";
import { expect, it, vi } from "vitest";
vi.mock("cloudflare:workers", () => ({
  // eslint-disable-next-line @typescript-eslint/no-extraneous-class
  RpcTarget: class {},
  // eslint-disable-next-line @typescript-eslint/no-extraneous-class
  WorkerEntrypoint: class {},
  // eslint-disable-next-line @typescript-eslint/no-extraneous-class
  DurableObject: class {},
}));

import { databaseFailureReason } from "../src/worker-service.js";
import { startTestPostgres } from "../../control-api/test/postgres.js";
import { DatabaseLanePool, pooledClientDependencies } from "../src/connection-pool.js";
import { createProjectDatabaseService } from "../src/service.js";

// Simulates a delayed Postgres startup answer to test the connection budget. Production readbacks
// measured a scaled-to-zero endpoint ready about 5.4 s after connecting; where that pre-wake time
// is spent (network, TLS or provider proxy) is not known, and this fixture does not claim it.
async function startupDelayProxy(target: { host: string; port: number }, delayMs: number | null) {
  const sockets = new Set<Socket>();
  const server: Server = createServer((client) => {
    sockets.add(client);
    client.pause();
    client.on("close", () => sockets.delete(client));
    client.on("error", () => client.destroy());
    if (delayMs === null) return; // never wakes
    setTimeout(() => {
      if (client.destroyed) return;
      const upstream = connect(target.port, target.host);
      sockets.add(upstream);
      upstream.on("close", () => sockets.delete(upstream));
      upstream.on("error", () => client.destroy());
      client.pipe(upstream).pipe(client);
      client.resume();
    }, delayMs);
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Proxy has no port");
  return {
    port: address.port,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((done) => server.close(() => done()));
    },
  };
}

async function laneThrough(connectionString: string, delayMs: number | null) {
  const upstream = new URL(connectionString);
  const proxy = await startupDelayProxy(
    { host: upstream.hostname, port: Number(upstream.port) },
    delayMs,
  );
  const uri = new URL(connectionString);
  uri.password = "local-test-password";
  uri.searchParams.set("sslmode", "require");
  const pool = new DatabaseLanePool(uri.href, 1);
  // The fixture proxy speaks plain TCP to the isolated local cluster; TLS is covered elsewhere.
  pool.options.host = "127.0.0.1";
  pool.options.port = proxy.port;
  pool.options.ssl = false;
  const service = createProjectDatabaseService(uri.href, pooledClientDependencies(pool));
  return {
    service,
    pool,
    close: async () => {
      await pool.invalidate();
      await proxy.close();
    },
  };
}

it("serves the first query when the endpoint answers the startup 6 s after the connection", async () => {
  const db = await startTestPostgres();
  const lane = await laneThrough(db.pool.options.connectionString as string, 6_000);
  try {
    const started = Date.now();
    await expect(
      lane.service.query({ text: "SELECT 1::int AS ready", values: [] }),
    ).resolves.toMatchObject({ rows: [{ ready: 1 }] });
    expect(Date.now() - started).toBeGreaterThanOrEqual(6_000);
  } finally {
    await lane.close();
    await db.stop();
  }
}, 30_000);

it("still fails an unreachable endpoint within 10 s and keeps the lane queue bounded", async () => {
  const db = await startTestPostgres();
  const lane = await laneThrough(db.pool.options.connectionString as string, null);
  try {
    const started = Date.now();
    const first = lane.service.query({ text: "SELECT 1::int AS ready", values: [] }).then(
      () => null,
      (error: unknown) => error,
    );
    // Waiters queued 2 s after the first attempt still wait when its 10 s connect bound ends, so
    // pg-pool starts one more attempt for the oldest of them. CI 36101366109 met this order by
    // chance; waiters queued in the same millisecond usually time out first. Two seconds keep the
    // order even if the event loop stalls briefly.
    await new Promise((done) => setTimeout(done, 2_000));
    // One lane connection is connecting; 32 more requests may wait for it, the next is refused.
    const queuedAt = Date.now();
    const queued = Array.from({ length: 32 }, () =>
      lane.service.query({ text: "SELECT 1", values: [] }).then(
        () => ({ error: null, elapsed: Date.now() - queuedAt }),
        (error: unknown) => ({ error, elapsed: Date.now() - queuedAt }),
      ),
    );
    await new Promise((done) => setTimeout(done, 100));
    const refused = await lane.service.query({ text: "SELECT 1", values: [] }).then(
      () => null,
      (error: unknown) => error,
    );
    expect(databaseFailureReason(refused)).toBe("busy");
    const failure = await first;
    const failedAt = Date.now();
    const elapsed = failedAt - started;
    expect(failure).toBeInstanceOf(Error);
    expect(databaseFailureReason(failure)).toBe("connect_timeout");
    expect(elapsed).toBeGreaterThanOrEqual(9_900);
    expect(elapsed).toBeLessThan(12_000);
    // The first attempt's end started exactly one more for the oldest waiter; the lane still holds
    // at most its one connection.
    expect([lane.pool.totalCount, lane.pool.waitingCount]).toEqual([1, 31]);
    // Every waiter still fails at its own 10 s deadline, not with the attempt started for it.
    for (const waiter of await Promise.all(queued)) {
      expect(databaseFailureReason(waiter.error)).toBe("connect_timeout");
      expect(waiter.elapsed).toBeGreaterThanOrEqual(9_900);
      expect(waiter.elapsed).toBeLessThan(12_000);
    }
    expect([lane.pool.totalCount, lane.pool.waitingCount]).toEqual([1, 0]);
    // That attempt began when the first one failed and ends at its own 10 s connect bound, so the
    // lane is empty within that bound plus the 2 s tolerance used above, before PostgreSQL stops.
    while (lane.pool.totalCount > 0 && Date.now() < failedAt + 12_000)
      await new Promise((done) => setTimeout(done, 25));
    const drained = Date.now() - failedAt;
    expect([lane.pool.totalCount, lane.pool.waitingCount]).toEqual([0, 0]);
    expect(drained).toBeGreaterThanOrEqual(9_900);
  } finally {
    await lane.close();
    await db.stop();
  }
}, 40_000);

it("ends a pooled statement at the 10 s server statement timeout and keeps the lane usable", async () => {
  const db = await startTestPostgres();
  const lane = await laneThrough(db.pool.options.connectionString as string, 0);
  try {
    await expect(
      lane.service.query({
        text: "SELECT current_setting('statement_timeout') AS limit",
        values: [],
      }),
    ).resolves.toMatchObject({ rows: [{ limit: "10s" }] });
    const started = Date.now();
    await expect(
      lane.service.query({ text: "SELECT pg_sleep(11)", values: [] }),
    ).rejects.toMatchObject({ code: "57014" });
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(9_900);
    expect(elapsed).toBeLessThan(12_000);
    await expect(
      lane.service.query({ text: "SELECT 1::int AS ready", values: [] }),
    ).resolves.toMatchObject({ rows: [{ ready: 1 }] });
  } finally {
    await lane.close();
    await db.stop();
  }
}, 40_000);
