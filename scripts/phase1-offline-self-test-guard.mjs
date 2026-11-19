import dgram from "node:dgram";
import dns from "node:dns";
import http from "node:http";
import http2 from "node:http2";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";

const denyNetwork = () => {
  throw new Error("OFFLINE_SELF_TEST_NETWORK_DENIED");
};

for (const module of [net, tls, http, http2, https, dgram]) {
  for (const name of ["connect", "createConnection", "request", "get", "createSocket"]) {
    if (typeof module[name] === "function") module[name] = denyNetwork;
  }
}

for (const prototype of [net.Socket.prototype, tls.TLSSocket.prototype]) {
  prototype.connect = denyNetwork;
}

for (const name of ["bind", "connect", "send"]) {
  if (typeof dgram.Socket.prototype[name] === "function") {
    dgram.Socket.prototype[name] = denyNetwork;
  }
}

for (const name of ["lookup", "resolve", "resolve4", "resolve6", "resolveAny"]) {
  if (typeof dns[name] === "function") dns[name] = denyNetwork;
  if (typeof dns.promises[name] === "function") dns.promises[name] = denyNetwork;
}

globalThis.fetch = denyNetwork;
