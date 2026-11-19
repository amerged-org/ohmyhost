/* global AbortSignal, Buffer, URL, fetch, setTimeout */
import { cp, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import http from "node:http";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { installNextRequestOrigin } from "./next-request-hook.mjs";
import { applyHmrOverlay } from "./hmr-probe.mjs";

const fixtures = new Set([
  "react-vite",
  "vanilla-vite",
  "tanstack-start",
  "next-edge",
  "astro-edge",
  "next-native-auth",
  "next-app-mail",
]);
const workspace = "/workspace/app";
const tooling = "/opt/preview-tooling/node_modules/wrangler/bin/wrangler.js";
const runtimeHome = "/opt/preview-spike";
const originalOriginHeader = "x-preview-spike-original-origin";
const mailVariables = [
  "OHMYHOST_MAIL_GATEWAY_URL",
  "OHMYHOST_MAIL_KEY",
  "OHMYHOST_PROJECT_ID",
  "PREVIEW_MAIL_RECIPIENT",
  "PREVIEW_ACCEPTANCE_KEY",
];

function run(file, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { cwd: workspace, stdio: "inherit", env: process.env });
    child.once("error", reject);
    child.once("exit", (code) => (code === 0 ? resolve() : reject(new Error("command_failed"))));
  });
}

function publicVariables(fixture, environment) {
  if (fixture !== "next-app-mail") return {};
  const result = {};
  for (const key of mailVariables) {
    const value = environment[key];
    if (value !== undefined) {
      if (typeof value !== "string" || value.length > 2048 || /[\r\n\0]/u.test(value))
        throw new Error("preview_public_variable_invalid");
      result[key] = value;
    }
  }
  return result;
}

async function originalConfig(directory, filename) {
  const saved = path.join(directory, ".spike-runtime", `original-${filename}`);
  try {
    return await readFile(saved, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    const original = await readFile(path.join(directory, filename), "utf8");
    await writeFile(saved, original, { flag: "wx" });
    return original;
  }
}

function replaceOnce(source, before, after) {
  if (source.split(before).length !== 2) throw new Error("preview_fixture_config_changed");
  return source.replace(before, after);
}

// Fixture source is a pinned public archive. These generated files contain only local service
// names and explicitly selected public mail markers; trusted authority stays outside the guest.
export async function configureFixture(
  directory,
  fixture,
  hostname,
  environment = {},
  home = runtimeHome,
) {
  if (!fixtures.has(fixture) || typeof hostname !== "string" || !/^[a-z0-9.-]+$/u.test(hostname))
    throw new Error("preview_fixture_configuration_invalid");
  if (environment.SPIKE_QA_FIXTURE !== undefined && environment.SPIKE_QA_FIXTURE !== fixture)
    throw new Error("preview_fixture_configuration_invalid");
  const qa = environment.SPIKE_QA_FIXTURE === fixture;
  const runtime = path.join(directory, ".spike-runtime");
  await mkdir(runtime, { recursive: true });
  const configPath = path.join(runtime, "application.jsonc");
  const bindingsPath = path.join(runtime, "bindings.jsonc");
  const staticVite = fixture === "react-vite" || fixture === "vanilla-vite";
  const multiWorker = staticVite && qa;
  const services = qa
    ? [{ binding: "OHMYHOST_DATABASE", service: "spike-bindings", entrypoint: "Database" }]
    : [];
  if (qa && fixture === "next-native-auth")
    services.push({ binding: "OHMYHOST_AUTH", service: "spike-bindings", entrypoint: "Auth" });
  let main;
  if (staticVite) {
    const entry = path.join(runtime, "companion-entry.mjs");
    const original = JSON.stringify(path.join(directory, "src/ohmyhost/companion.ts"));
    // Wrangler's local proxy can rewrite Origin and the request URL. Restore the exact browser
    // Origin supplied by our private frontend proxy and the signed public fixture hostname.
    await writeFile(
      entry,
      `import application from ${original};\nexport default { fetch(request, env, ctx) { const url = new URL(request.url); url.protocol = "https:"; url.host = ${JSON.stringify(hostname)}; url.port = ""; const headers = new Headers(request.headers); const original = headers.get(${JSON.stringify(originalOriginHeader)}); headers.delete(${JSON.stringify(originalOriginHeader)}); headers.delete("origin"); if (original !== null) headers.set("origin", atob(original)); return application.fetch(new Request(url, new Request(request, {headers})), env, ctx); } };\n`,
    );
    main = entry;
  } else if (fixture === "tanstack-start") main = "@tanstack/react-start/server-entry";
  const config = {
    name: "spike-application",
    ...(main ? { main } : {}),
    compatibility_date: "2026-08-21",
    compatibility_flags: ["nodejs_compat"],
    services,
    vars: qa ? publicVariables(fixture, environment) : {},
    observability: { enabled: false },
    dev: {
      ip: "127.0.0.1",
      port: multiWorker ? 3003 : 3001,
      local_protocol: "http",
      host: hostname,
      upstream_protocol: "https",
    },
  };
  const bindingConfig = {
    name: "spike-bindings",
    main: path.join(home, "bindings-worker.mjs"),
    compatibility_date: "2026-08-21",
    compatibility_flags: ["nodejs_compat"],
    observability: { enabled: false },
    ...(multiWorker
      ? { services: [{ binding: "PREVIEW_APPLICATION", service: "spike-application" }] }
      : {}),
    dev: { ip: "127.0.0.1", port: multiWorker ? 3003 : 3002, local_protocol: "http" },
  };
  await writeFile(configPath, JSON.stringify(config));
  await writeFile(bindingsPath, JSON.stringify(bindingConfig));
  if (fixture.startsWith("next-")) {
    // OpenNext can initialize a second context from the default Wrangler config before its
    // explicit initializer settles. Both paths must see the same local-only bindings.
    await writeFile(path.join(directory, "wrangler.jsonc"), JSON.stringify(config));
    const original = await originalConfig(directory, "next.config.ts");
    const configured = replaceOnce(
      original,
      "const nextConfig: NextConfig = {};",
      `const nextConfig: NextConfig = { allowedDevOrigins: [${JSON.stringify(hostname)}] };`,
    );
    await writeFile(
      path.join(directory, "next.config.ts"),
      `${configured}\nimport { initOpenNextCloudflareForDev } from '@opennextjs/cloudflare';\ninitOpenNextCloudflareForDev({configPath:${JSON.stringify(configPath)},persist:false,envFiles:[]});\n`,
    );
  } else if (fixture === "astro-edge") {
    const original = await originalConfig(directory, "astro.config.mjs");
    await writeFile(
      path.join(directory, "astro.config.mjs"),
      replaceOnce(
        original,
        'cloudflare({ imageService: "passthrough" })',
        `cloudflare({ imageService: "passthrough", configPath: ${JSON.stringify(configPath)} })`,
      ),
    );
  } else if (fixture === "tanstack-start") {
    const original = await originalConfig(directory, "vite.config.ts");
    await writeFile(
      path.join(directory, "vite.config.ts"),
      replaceOnce(
        original,
        "cloudflare({ viteEnvironment:",
        `cloudflare({ configPath: ${JSON.stringify(configPath)}, viteEnvironment:`,
      ),
    );
  }
  return { configPath, bindingsPath, staticVite, multiWorker, qa };
}

export function proxyForVite(
  hostname,
  { astro = false, appPort = 3004, companionPort = 3003 } = {},
) {
  function target(request) {
    return !astro && new URL(request.url, "http://localhost").pathname.startsWith("/api/")
      ? companionPort
      : appPort;
  }
  function headers(request, port) {
    const result = {};
    for (const [name, value] of Object.entries(request.headers))
      if (!/^(?:mf-|x-mf-|x-preview-spike-|x-forwarded-|forwarded$)/iu.test(name))
        result[name] = value;
    result.host = hostname;
    if (astro) {
      result["x-forwarded-proto"] = "https";
      result["x-forwarded-host"] = hostname;
      result.forwarded = `proto=https;host="${hostname}"`;
    }
    if (!astro && port === companionPort && typeof request.headers.origin === "string")
      result[originalOriginHeader] = Buffer.from(request.headers.origin, "latin1").toString(
        "base64",
      );
    return result;
  }
  function responseHeaders(original) {
    if (!astro) return original;
    const result = { ...original };
    if (typeof result.location === "string" && /^https?:\/\//iu.test(result.location)) {
      try {
        const location = new URL(result.location);
        if (
          location.protocol === "http:" &&
          ((["127.0.0.1", "localhost"].includes(location.hostname) &&
            location.port === String(appPort)) ||
            (location.hostname === hostname && location.port === ""))
        ) {
          location.protocol = "https:";
          location.host = hostname;
          location.port = "";
          result.location = location.href;
        }
      } catch {
        // Leave malformed application headers to the client instead of crashing the proxy.
      }
    }
    if (Array.isArray(result["set-cookie"]))
      result["set-cookie"] = result["set-cookie"].map((value) =>
        value.replace(/;\s*domain=(?:127\.0\.0\.1|localhost)(?=;|$)/giu, ""),
      );
    return result;
  }
  const proxy = http.createServer((request, response) => {
    // Validate Astro mutations against the signed public origin before forwarding the request
    // with trusted public Host and protocol headers to its loopback dev server.
    if (
      astro &&
      !["GET", "HEAD", "OPTIONS"].includes(request.method) &&
      request.headers.origin !== `https://${hostname}`
    ) {
      response.writeHead(403);
      response.end("Forbidden");
      return;
    }
    const port = target(request);
    const upstream = http.request(
      {
        hostname: "127.0.0.1",
        port,
        method: request.method,
        path: request.url,
        headers: headers(request, port),
      },
      (reply) => {
        response.writeHead(reply.statusCode ?? 502, responseHeaders(reply.headers));
        reply.pipe(response);
      },
    );
    upstream.on("error", () => {
      if (!response.headersSent) response.writeHead(502);
      response.end();
    });
    request.on("aborted", () => upstream.destroy());
    response.on("close", () => upstream.destroy());
    request.pipe(upstream);
  });
  proxy.on("upgrade", (request, socket, head) => {
    const port = target(request);
    const upstream = http.request({
      hostname: "127.0.0.1",
      port,
      method: "GET",
      path: request.url,
      headers: headers(request, port),
    });
    upstream.on("upgrade", (reply, peer, initial) => {
      socket.write(
        `HTTP/1.1 ${reply.statusCode} ${reply.statusMessage}\r\n${reply.rawHeaders.reduce((lines, item, index) => lines + (index % 2 === 0 ? `${item}: ` : `${item}\r\n`), "")}\r\n`,
      );
      if (initial.length) socket.write(initial);
      if (head.length) peer.write(head);
      peer.pipe(socket).pipe(peer);
    });
    upstream.on("error", () => socket.destroy());
    upstream.on("response", () => socket.destroy());
    upstream.end();
  });
  return proxy;
}

async function serve(fixture, hostname) {
  const configuration = await configureFixture(workspace, fixture, hostname, process.env);
  const forwardedEnvironment = Object.fromEntries(
    ["PATH", "HOME", "COREPACK_HOME", "CI", "NODE_EXTRA_CA_CERTS", "REQUESTS_CA_BUNDLE"]
      .filter((name) => process.env[name] !== undefined)
      .map((name) => [name, process.env[name]]),
  );
  const environment = {
    ...forwardedEnvironment,
    __VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS: hostname,
    CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "false",
    WRANGLER_SEND_METRICS: "false",
    NEXT_TELEMETRY_DISABLED: "1",
    ASTRO_TELEMETRY_DISABLED: "1",
  };
  const children = new Set();
  let proxy;
  let stopping = false;
  const stop = (code) => {
    if (stopping) return;
    stopping = true;
    proxy?.close();
    for (const child of children) {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        /* Already exited. */
      }
    }
    process.exit(code);
  };
  const start = (args, extraEnvironment = {}) => {
    const child = spawn(process.execPath, args, {
      cwd: workspace,
      detached: true,
      stdio: "inherit",
      env: { ...environment, ...extraEnvironment },
    });
    children.add(child);
    child.once("error", () => stop(1));
    child.once("exit", (code) => stop(code ?? 1));
  };
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => stop(0));
  const wrangler = [
    tooling,
    "dev",
    "--local",
    "--ip",
    "127.0.0.1",
    "--port",
    configuration.multiWorker ? "3003" : "3002",
    "--config",
    configuration.bindingsPath,
  ];
  if (configuration.multiWorker) wrangler.push("--config", configuration.configPath);
  let astroEntry;
  if (fixture.startsWith("next-")) await installNextRequestOrigin(workspace, `https://${hostname}`);
  if (fixture === "astro-edge") {
    const astroRoot = `${workspace}/node_modules/astro`;
    const manifest = JSON.parse(await readFile(`${astroRoot}/package.json`, "utf8"));
    const entry = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.astro;
    if (typeof entry !== "string" || path.isAbsolute(entry) || entry.split("/").includes(".."))
      throw new Error("invalid_astro_binary");
    astroEntry = path.join(astroRoot, entry);
  }
  if (configuration.qa) {
    // Pin Miniflare's built-in placeholder for these offline fixtures and avoid
    // a cf.json lookup. A usable cached cf.json would otherwise be preferred.
    start(wrangler, configuration.multiWorker ? { CLOUDFLARE_CF_FETCH_ENABLED: "false" } : {});
    if (!configuration.multiWorker) {
      let ready = false;
      for (let attempt = 0; attempt < 120; attempt++) {
        try {
          const response = await fetch("http://127.0.0.1:3002/", {
            signal: AbortSignal.timeout(1000),
          });
          await response.body?.cancel();
          if (response.ok) {
            ready = true;
            break;
          }
        } catch {
          // The local bindings process is still starting.
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      if (!ready) stop(1);
    }
  }
  if (fixture.startsWith("next-")) {
    start([
      `${workspace}/node_modules/next/dist/bin/next`,
      "dev",
      "--hostname",
      "0.0.0.0",
      "--port",
      "3001",
    ]);
  } else if (fixture === "astro-edge") {
    start([
      astroEntry,
      "dev",
      "--host",
      "127.0.0.1",
      "--port",
      "3004",
      "--allowed-hosts",
      hostname,
    ]);
    proxy = proxyForVite(hostname, { astro: true });
    proxy.on("error", () => stop(1));
    proxy.listen(3001, "0.0.0.0");
  } else {
    start([
      `${workspace}/node_modules/vite/bin/vite.js`,
      "--host",
      configuration.multiWorker ? "127.0.0.1" : "0.0.0.0",
      "--port",
      configuration.multiWorker ? "3004" : "3001",
      "--strictPort",
    ]);
    if (configuration.multiWorker) {
      proxy = proxyForVite(hostname);
      proxy.on("error", () => stop(1));
      proxy.listen(3001, "0.0.0.0");
    }
  }
}

async function main() {
  const [operation, fixture, hostname, cacheMode] = process.argv.slice(2);
  if (!fixtures.has(fixture)) throw new Error("preview_fixture_invalid");
  if (operation === "prepare") {
    if ((await readdir(workspace)).length !== 0) throw new Error("workspace_not_empty");
    await cp(`/opt/fixtures/${fixture}/.`, workspace, { recursive: true, force: false });
    await applyHmrOverlay(workspace, fixture);
    try {
      await stat(`${workspace}/node_modules`);
      throw new Error("unexpected_node_modules");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const pnpmStore = cacheMode === "seeded" ? "/opt/pnpm-store" : "/home/preview/empty-pnpm-store";
    const npmCache = cacheMode === "seeded" ? "/opt/npm-cache" : "/home/preview/empty-npm-cache";
    if (fixture === "astro-edge")
      await run("npm", [
        "ci",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        `--cache=${npmCache}`,
        "--prefer-offline",
      ]);
    else
      await run("corepack", [
        "pnpm@10.28.2",
        "install",
        "--frozen-lockfile",
        "--ignore-scripts",
        "--config.package-import-method=copy",
        `--store-dir=${pnpmStore}`,
        "--prefer-offline",
      ]);
  } else if (operation === "serve") await serve(fixture, hostname);
  else throw new Error("preview_operation_invalid");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await main();
