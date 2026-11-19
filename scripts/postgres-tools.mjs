/* global process, setTimeout, clearTimeout */
// Shared native PostgreSQL boundary; the portability CLI is intentionally separate from the recovery runner.
import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import { URL } from "node:url";

const MAX_OUTPUT_BYTES = 1024 * 1024;
export const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024;
const COMMAND_TIMEOUT_MS = 15 * 60_000;
const ALLOWED_QUERY_PARAMETERS = new Set(["channel_binding", "sslmode"]);
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

export function parsePostgresProofConnection(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    invalidConnection();
  }
  if (
    (url.protocol !== "postgresql:" && url.protocol !== "postgres:") ||
    url.username === "" ||
    url.hostname === "" ||
    !/^\/[A-Za-z0-9_.-]+$/u.test(url.pathname) ||
    [...url.searchParams.keys()].some((key) => !ALLOWED_QUERY_PARAMETERS.has(key)) ||
    /(?:^|\.)[^.]*-pooler(?:\.|$)/u.test(url.hostname)
  ) {
    invalidConnection();
  }
  const sslMode = url.searchParams.get("sslmode");
  const channelBinding = url.searchParams.get("channel_binding");
  const loopback = LOOPBACK_HOSTS.has(url.hostname);
  if (
    (!loopback && sslMode !== "require" && sslMode !== "verify-full") ||
    (channelBinding !== null && channelBinding !== "prefer" && channelBinding !== "require")
  ) {
    invalidConnection();
  }
  const port = url.port === "" ? "5432" : url.port;
  if (!/^\d{1,5}$/u.test(port) || Number(port) < 1 || Number(port) > 65_535) invalidConnection();
  const environment = Object.freeze({
    PGHOST: url.hostname,
    PGPORT: port,
    PGUSER: decodeURIComponent(url.username),
    PGPASSWORD: decodeURIComponent(url.password),
    PGDATABASE: decodeURIComponent(url.pathname.slice(1)),
    PGCONNECT_TIMEOUT: "10",
    PGAPPNAME: "ohmyhost-portability-proof",
    PGTZ: "UTC",
    ...(sslMode === null ? {} : { PGSSLMODE: sslMode }),
    ...(sslMode === "verify-full" ? { PGSSLROOTCERT: "system" } : {}),
    ...(channelBinding === null ? {} : { PGCHANNELBINDING: channelBinding }),
  });
  return Object.freeze({
    environment,
    identity: Object.freeze({
      host: url.hostname,
      port,
      database: decodeURIComponent(url.pathname.slice(1)),
      sslMode: sslMode ?? (loopback ? "local-default" : "invalid"),
      direct: true,
    }),
  });
}

/** PGCF API URIs may omit sslmode; only an independently bound WSS target permits that form. */
export function parsePgcfProofConnection(value, target) {
  let descriptor, uri;
  try {
    descriptor = typeof target === "string" ? JSON.parse(target) : target;
    uri = new URL(value);
  } catch {
    invalidConnection();
  }
  if (
    !descriptor ||
    typeof descriptor !== "object" ||
    Array.isArray(descriptor) ||
    Object.keys(descriptor).sort().join(",") !== "databaseId,host,provider,role" ||
    descriptor.provider !== "pgcf" ||
    descriptor.host !== uri.hostname ||
    descriptor.databaseId !== decodeURIComponent(uri.pathname.slice(1)) ||
    descriptor.role !== decodeURIComponent(uri.username) ||
    !/^[a-z][a-z0-9]{19}$/u.test(descriptor.databaseId) ||
    !["", "?sslmode=require", "?sslmode=verify-full"].includes(uri.search) ||
    uri.hash ||
    !uri.password
  )
    invalidConnection();
  if (!uri.search) uri.searchParams.set("sslmode", "require");
  return parsePostgresProofConnection(uri.href);
}

/** Explicit PGCF target enables loopback native tools; a plain PostgreSQL URI never implies WSS. */
export async function openPostgresProofConnection(value, target) {
  const connection =
    target === undefined
      ? parsePostgresProofConnection(value)
      : parsePgcfProofConnection(value, target);
  if (target === undefined) return { ...connection, close: async () => undefined };
  const { startBridge } = await import("../packages/postgres-bridge/dist/index.js");
  const bridge = await startBridge({
    endpoint: `wss://${connection.identity.host}/`,
    database: connection.identity.database,
    user: connection.environment.PGUSER,
    port: 0,
  });
  return {
    ...connection,
    environment: Object.freeze({
      ...connection.environment,
      PGHOST: bridge.host,
      PGPORT: String(bridge.port),
      PGSSLMODE: "disable",
      PGCHANNELBINDING: "disable",
      PGGSSENCMODE: "disable",
      PGCONNECT_TIMEOUT: "75",
    }),
    close: () => bridge.close(),
  };
}

export function runPostgresCommand(command, arguments_, postgresEnvironment, options = {}) {
  const maximumBytes = options.maximumBytes ?? MAX_OUTPUT_BYTES;
  if (
    !Number.isSafeInteger(maximumBytes) ||
    maximumBytes < 1 ||
    maximumBytes > MAX_ARCHIVE_BYTES ||
    (options.input !== undefined &&
      (!(options.input instanceof Uint8Array) || options.input.byteLength > MAX_ARCHIVE_BYTES))
  )
    throw new Error("POSTGRES_PORTABILITY_COMMAND_INPUT_INVALID");
  return new Promise((resolveCommand, rejectCommand) => {
    const child = spawn(command, arguments_, {
      ...(options.signal === undefined ? {} : { signal: options.signal, killSignal: "SIGKILL" }),
      env: {
        ...(typeof process.env.PATH === "string" ? { PATH: process.env.PATH } : {}),
        ...(typeof process.env.LANG === "string" ? { LANG: process.env.LANG } : {}),
        ...postgresEnvironment,
      },
      stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    let byteLength = 0;
    const collect = (target) => (chunk) => {
      byteLength += chunk.byteLength;
      if (byteLength > maximumBytes) child.kill("SIGKILL");
      else target.push(chunk);
    };
    child.stdout.on("data", collect(stdout));
    child.stderr.on("data", collect(stderr));
    let inputFailed = false;
    if (options.input !== undefined) {
      child.stdin.on("error", () => {
        inputFailed = true;
        child.kill("SIGKILL");
      });
      child.stdin.end(options.input);
    }
    const timer = setTimeout(() => child.kill("SIGKILL"), COMMAND_TIMEOUT_MS);
    child.once("error", (error) => {
      clearTimeout(timer);
      rejectCommand(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code !== 0 || inputFailed || byteLength > maximumBytes) {
        rejectCommand(new Error("POSTGRES_PORTABILITY_COMMAND_FAILED"));
        return;
      }
      if (Buffer.concat(stderr).toString("utf8").trim() !== "") {
        rejectCommand(new Error("POSTGRES_PORTABILITY_COMMAND_FAILED"));
        return;
      }
      const output = Buffer.concat(stdout);
      resolveCommand(options.binary === true ? output : output.toString("utf8"));
    });
  });
}

function invalidConnection() {
  throw new Error("POSTGRES_PORTABILITY_CONNECTION_INVALID");
}
