import { once } from "node:events";
import { connect, type AddressInfo } from "node:net";
import WebSocket, { createWebSocketStream, WebSocketServer } from "ws";
import { UPSTREAM_OPTIONS } from "../src/bridge.js";

/** Isolated test lane only: real PostgreSQL bytes over local WS; production requires verified WSS. */
export async function postgresProxy(port: number) {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  let current = 0,
    maximum = 0;
  server.on("connection", (peer) => {
    current++;
    maximum = Math.max(maximum, current);
    const stream = createWebSocketStream(peer),
      tcp = connect({ host: "127.0.0.1", port });
    const close = () => {
      tcp.destroy();
      stream.destroy();
      peer.terminate();
    };
    tcp.on("error", close);
    stream.on("error", close);
    peer.on("error", close);
    peer.once("close", () => {
      current--;
      tcp.destroy();
    });
    tcp.pipe(stream).pipe(tcp);
  });
  return {
    get current() {
      return current;
    },
    get maximum() {
      return maximum;
    },
    connect: () =>
      new WebSocket(`ws://127.0.0.1:${(server.address() as AddressInfo).port}`, UPSTREAM_OPTIONS),
    close: async () => {
      for (const peer of server.clients) peer.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
