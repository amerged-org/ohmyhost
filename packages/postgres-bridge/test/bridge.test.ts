import { once } from "node:events";
import { connect, type AddressInfo } from "node:net";
import { expect, it } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import { BackendAuthentication, FrontendPrelude } from "../src/auth.js";
import {
  startBridge,
  connectUpstream,
  STREAM_BYTES,
  UPSTREAM_OPTIONS,
  type Session,
} from "../src/bridge.js";
import { upstreamUrl, validateOptions } from "../src/options.js";

const options = {
  endpoint: "wss://pgcf.example.test/",
  database: "a".repeat(20),
  user: "app",
  port: 0,
};
const authentication = (code: number, payload = Buffer.alloc(0)) => {
  const result = Buffer.alloc(9 + payload.length);
  result[0] = 0x52;
  result.writeUInt32BE(result.length - 1, 1);
  result.writeUInt32BE(code, 5);
  payload.copy(result, 9);
  return result;
};
const offer = (...names: string[]) => authentication(10, Buffer.from(names.join("\0") + "\0\0"));
async function filter(chunks: Buffer[], backend = new BackendAuthentication()): Promise<Buffer> {
  const bytes: Buffer[] = [];
  backend.on("data", (chunk: Buffer) => bytes.push(chunk));
  const done = new Promise<Buffer>((resolve, reject) => {
    backend.once("end", () => resolve(Buffer.concat(bytes)));
    backend.once("error", reject);
  });
  for (const chunk of chunks) backend.write(chunk);
  backend.end();
  return done;
}

it("bounds endpoints and loopback streams and closes every live session with its bridge", async () => {
  expect(upstreamUrl(validateOptions(options))).toBe(
    `wss://pgcf.example.test/v2?database=${options.database}&user=app`,
  );
  for (const change of [
    { endpoint: "ws://localhost/" },
    { endpoint: "wss://user:password@pgcf.example.test/" },
    { endpoint: "wss://pgcf.example.test/?token=secret" },
    { endpoint: "wss://pgcf.example.test/v2" },
    { database: "wrong" },
    { user: "bad-user" },
    { port: -1 },
  ])
    expect(() => validateOptions({ ...options, ...change })).toThrow();
  expect(() => connectUpstream("ws://localhost/")).toThrow();
  expect(UPSTREAM_OPTIONS).toMatchObject({
    rejectUnauthorized: true,
    followRedirects: false,
    maxPayload: 1024 * 1024,
    perMessageDeflate: false,
  });
  const failed = connectUpstream("wss://127.0.0.1:9/");
  await once(failed, "error");
  failed.terminate();
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const received: Buffer[] = [];
  let seenUrl = "";
  let session: Session | undefined;
  server.on("connection", (peer) => {
    peer.on("error", () => undefined);
    peer.on("message", (data) => received.push(Buffer.from(data as Buffer)));
    peer.send(
      Buffer.concat([
        offer("SCRAM-SHA-256-PLUS", "SCRAM-SHA-256"),
        authentication(0),
        Buffer.from("ready"),
      ]),
    );
    peer.ping(Buffer.from("health"));
  });
  const bridge = await startBridge(options, {
    session: (value) => {
      session = value;
    },
    connect: (url) => {
      seenUrl = url;
      return new WebSocket(
        `ws://127.0.0.1:${(server.address() as AddressInfo).port}`,
        UPSTREAM_OPTIONS,
      );
    },
  });
  const socket = connect({ host: bridge.host, port: bridge.port });
  socket.on("error", () => undefined);
  try {
    expect(bridge.host).toBe("127.0.0.1");
    const chunks: Buffer[] = [];
    await new Promise<void>((resolve) =>
      socket.on("data", (chunk: Buffer) => {
        chunks.push(chunk);
        if (Buffer.concat(chunks).includes(Buffer.from("ready"))) resolve();
      }),
    );
    expect(Buffer.concat(chunks)).toEqual(
      Buffer.concat([offer("SCRAM-SHA-256"), authentication(0), Buffer.from("ready")]),
    );
    expect(seenUrl).toBe(upstreamUrl(options));
    expect(bridge.clients).toBe(1);
    const startup = Buffer.alloc(8);
    startup.writeUInt32BE(8);
    startup.writeUInt32BE(196608, 4);
    socket.write(startup);
    await expect.poll(() => Buffer.concat(received)).toEqual(startup);
    await expect(startBridge({ ...options, port: bridge.port })).rejects.toThrow("listener_failed");
    if (!session) throw new Error("Missing test session");
    const ended = once(session.local, "end"),
      closed = once(socket, "close");
    socket.end();
    await ended;
    for (const peer of server.clients) peer.close();
    await closed;
    const interrupted = connect({ host: bridge.host, port: bridge.port });
    interrupted.on("error", () => undefined);
    await once(interrupted, "data");
    const interruptedClosed = once(interrupted, "close");
    session.local.destroy(new Error("test connection reset"));
    await interruptedClosed;
    await bridge.close();
    await bridge.close();
    expect(bridge.clients).toBe(0);
  } finally {
    socket.destroy();
    await bridge.close();
    for (const peer of server.clients) peer.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

it("passes fragmented SCRAM proofs exactly and refuses cleartext, malformed and truncated authentication", async () => {
  const challenge = authentication(11, Buffer.from("challenge")),
    proof = authentication(12, Buffer.from("proof"));
  const source = Buffer.concat([
    offer("SCRAM-SHA-256-PLUS", "SCRAM-SHA-256"),
    challenge,
    proof,
    authentication(0),
    Buffer.from("SQL result"),
  ]);
  expect(await filter([...source].map((byte) => Buffer.from([byte])))).toEqual(
    Buffer.concat([
      offer("SCRAM-SHA-256"),
      challenge,
      proof,
      authentication(0),
      Buffer.from("SQL result"),
    ]),
  );
  expect(await filter([offer("SCRAM-SHA-256")])).toEqual(offer("SCRAM-SHA-256"));
  for (const data of [
    authentication(3),
    authentication(5),
    offer("SCRAM-SHA-256-PLUS"),
    Buffer.concat([offer("SCRAM-SHA-256"), offer("SCRAM-SHA-256")]),
    offer("SCRAM-SHA-256").subarray(0, 7),
  ])
    await expect(filter([data])).rejects.toThrow();
});

it("tracks SSL/GSS preludes without confusing backend messages and refuses malformed frontend bytes", async () => {
  const backend = new BackendAuthentication(),
    frontend = new FrontendPrelude(backend),
    bytes: Buffer[] = [];
  frontend.on("data", (chunk: Buffer) => bytes.push(chunk));
  const prelude = Buffer.alloc(8);
  prelude.writeUInt32BE(8);
  prelude.writeUInt32BE(80877103, 4);
  for (const byte of prelude) frontend.write(Buffer.from([byte]));
  expect(Buffer.concat(bytes)).toEqual(prelude);
  expect(await filter([Buffer.from("N"), authentication(0)], backend)).toEqual(
    Buffer.concat([Buffer.from("N"), authentication(0)]),
  );
  frontend.end();
  await once(frontend, "end");
  const invalidBackend = new BackendAuthentication(),
    invalid = new FrontendPrelude(invalidBackend);
  const error = once(invalid, "error");
  prelude.writeUInt32BE(9);
  invalid.end(prelude);
  expect((await error)[0]).toBeInstanceOf(Error);
  invalidBackend.destroy();
  const truncated = new FrontendPrelude(new BackendAuthentication());
  const failure = once(truncated, "error");
  truncated.end(Buffer.from([0]));
  await failure;
});

it("answers a ping with a pong even while the upstream send buffer is above the stream limit", async () => {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  let session: Session | undefined;
  const bridge = await startBridge(options, {
    session: (value) => {
      session = value;
    },
    connect: () => {
      const upstream = new WebSocket(
        `ws://127.0.0.1:${(server.address() as AddressInfo).port}`,
        UPSTREAM_OPTIONS,
      );
      // A congested upstream reports a send buffer at the limit; the ping must still be answered.
      Object.defineProperty(upstream, "bufferedAmount", { get: () => STREAM_BYTES });
      return upstream;
    },
  });
  const socket = connect({ host: bridge.host, port: bridge.port });
  socket.on("error", () => undefined);
  try {
    const [peer] = (await once(server, "connection")) as [WebSocket, unknown];
    peer.on("error", () => undefined);
    const pong = once(peer, "pong");
    peer.ping(Buffer.from("probe"));
    await pong;
    expect(session?.upstream.readyState).toBe(WebSocket.OPEN);
    expect(bridge.clients).toBe(1);
  } finally {
    socket.destroy();
    await bridge.close();
    for (const peer of server.clients) peer.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
