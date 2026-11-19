import { appendFileSync } from "node:fs";
import { createRequire } from "node:module";
import net from "node:net";
import path from "node:path";
import process from "node:process";
import { URL } from "node:url";
const require = createRequire(path.join(process.env.CF_TEST_TOOLING_ROOT, "package.json"));
const undici = require("undici");
const fetch = undici.fetch.bind(undici);
undici.fetch = async (input, init) => {
  const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  if (["localhost", "127.0.0.1", "[::1]", "dummy"].includes(url.hostname))
    return fetch(input, init);
  if (url.href !== "https://workers.cloudflare.com/cf.json") {
    appendFileSync(process.env.CF_TEST_MARKER, "unexpected\n");
    throw new Error("unexpected_fetch_denied");
  }
  appendFileSync(process.env.CF_TEST_MARKER, "attempt\n");
  return await new Promise((resolve, reject) => {
    const signal = init?.signal;
    if (!signal) return reject(new Error("missing_timeout"));
    if (signal.aborted) return reject(new Error("mock_cf_timeout"));
    signal.addEventListener("abort", () => reject(new Error("mock_cf_timeout")), { once: true });
  });
};
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const options = Array.isArray(args[0]) ? args[0][0] : args[0];
  const host =
    typeof options === "object" && options !== null
      ? (options.host ?? options.hostname)
      : typeof args[1] === "string"
        ? args[1]
        : "localhost";
  if (host && !["localhost", "127.0.0.1", "::1"].includes(host)) {
    appendFileSync(process.env.CF_TEST_MARKER, "unexpected\n");
    throw new Error("external_socket_denied");
  }
  return connect.apply(this, args);
};
