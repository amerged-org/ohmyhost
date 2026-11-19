/* global Response, setTimeout */
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { writeFileSync } from "node:fs";
import http from "node:http";
import { syncBuiltinESMExports } from "node:module";
import process from "node:process";

const records = [];
const fakePid = 999999;
process.kill = (pid) => {
  if (pid === -fakePid) return true;
  throw new Error("unexpected_test_process_kill");
};
childProcess.spawn = (file, args, options) => {
  const target = args[0]?.endsWith("/wrangler.js")
    ? "wrangler"
    : args[0]?.endsWith("/vite.js")
      ? "vite"
      : "unexpected";
  records.push({
    target,
    hasFlag: Object.hasOwn(options.env, "CLOUDFLARE_CF_FETCH_ENABLED"),
    value: options.env.CLOUDFLARE_CF_FETCH_ENABLED ?? null,
  });
  const child = new EventEmitter();
  child.pid = fakePid;
  if (records.length === 2) {
    writeFileSync(process.env.CF_DRIVER_REPORT, JSON.stringify(records));
    setTimeout(() => process.exit(0), 0);
  }
  return child;
};
syncBuiltinESMExports();
http.createServer = () => {
  const proxy = new EventEmitter();
  proxy.listen = () => proxy;
  proxy.close = () => {};
  return proxy;
};
globalThis.fetch = async () => new Response("ready");
