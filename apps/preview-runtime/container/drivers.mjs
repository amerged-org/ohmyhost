import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL, URL } from "node:url";
import { prepareNativeLoader, resolveNativePublicEntry } from "./native-loader.mjs";
import { readFrameworkBuildArguments } from "../../build-runner/sandbox/build-runtime.mjs";
import { ORIGINAL_BROWSER_HEADERS } from "./protocol.mjs";

const TOOL_ROOT = "/opt/ohmyhost-platform/bin";
const here = path.dirname(fileURLToPath(import.meta.url));
export const APPLICATION_PORT = 3001;
export const COMPANION_PORT = 3003;
export const BINDINGS_PORT = 3002;

/** Frozen, script-free installation is the same admitted contract used by production builds. */
export function frozenInstallCommand(manager) {
  if (manager.manager === "npm")
    return {
      file: "npm",
      args: [
        "exec",
        "--cache=/workspace/home/npm-cache",
        "--prefer-offline",
        "--yes",
        "--ignore-scripts",
        `--package=npm@${manager.version}`,
        "--",
        "npm",
        "ci",
        "--cache=/workspace/home/npm-cache",
        "--prefer-offline",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
      ],
    };
  if (manager.manager === "pnpm")
    return {
      file: `${TOOL_ROOT}/corepack`,
      args: [
        `pnpm@${manager.version}`,
        "install",
        "--frozen-lockfile",
        "--ignore-scripts",
        "--config.package-import-method=copy",
        "--store-dir=/workspace/home/pnpm-store",
        "--prefer-offline",
      ],
    };
  if (manager.manager === "yarn")
    return {
      file: `${TOOL_ROOT}/corepack`,
      args: [`yarn@${manager.version}`, "install", "--immutable", "--mode=skip-build"],
    };
  if (manager.manager === "bun" && manager.version === "1.2.22")
    return { file: `${TOOL_ROOT}/bun`, args: ["install", "--frozen-lockfile", "--ignore-scripts"] };
  throw new Error("preview_package_manager_invalid");
}

/** A trusted npm graph snapshot can be checked without npm ci deleting every restored package. */
export function frozenVerificationCommand(manager) {
  if (manager.manager === "npm")
    return {
      file: "npm",
      args: [
        "exec",
        "--cache=/workspace/home/npm-cache",
        "--prefer-offline",
        "--yes",
        "--ignore-scripts",
        `--package=npm@${manager.version}`,
        "--",
        "npm",
        "ls",
        "--all",
        "--offline",
        "--json",
      ],
    };
  return frozenInstallCommand(manager);
}

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value)}\n`, { mode: 0o600, flag: "wx" });
}

function binary(root, relative) {
  const candidate = path.join(root, "node_modules", relative);
  if (!fs.statSync(candidate).isFile()) throw new Error("preview_framework_binary_missing");
  return candidate;
}

/** The package owns its public CLI layout; metadata is read as JSON and never evaluated. */
function packageBinary(root, packageName, command) {
  root = fs.realpathSync(root);
  const invalid = () => {
    throw new Error("preview_framework_binary_invalid");
  };
  const manifest = fs.realpathSync(path.join(root, "node_modules", packageName, "package.json"));
  const rootRelative = path.relative(root, manifest);
  const status = fs.statSync(manifest);
  if (
    rootRelative === ".." ||
    rootRelative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(rootRelative) ||
    !status.isFile() ||
    status.size > 65_536
  )
    return invalid();
  const metadata = JSON.parse(fs.readFileSync(manifest, "utf8"));
  const declared = typeof metadata.bin === "string" ? metadata.bin : metadata.bin?.[command];
  if (
    metadata.name !== packageName ||
    typeof declared !== "string" ||
    declared.includes("\0") ||
    path.isAbsolute(declared)
  )
    return invalid();
  const directory = path.dirname(manifest);
  const filename = fs.realpathSync(path.resolve(directory, declared));
  const relative = path.relative(directory, filename);
  if (
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative) ||
    !fs.statSync(filename).isFile()
  )
    return invalid();
  return filename;
}

/** Generate local-only Worker configuration; customer provider configuration is never loaded. */
export function writeFrameworkConfiguration(
  input,
  applicationRoot,
  { runtimeConfigRoot, repositoryRoot },
) {
  fs.mkdirSync(runtimeConfigRoot, { recursive: true, mode: 0o700 });
  const multiWorker =
    (input.adapter === "functions" ||
      (input.adapter === "vite-static" && input.runtime === "edge")) &&
    (input.capabilityBindings.database || input.capabilityBindings.auth);
  const bindingName = `preview-bindings-${input.sessionId.toLowerCase()}`;
  const services = [];
  if (input.capabilityBindings.database)
    services.push({ binding: "OHMYHOST_DATABASE", service: bindingName, entrypoint: "Database" });
  if (input.capabilityBindings.auth)
    services.push({ binding: "OHMYHOST_AUTH", service: bindingName, entrypoint: "Auth" });
  const configPath = path.join(runtimeConfigRoot, "application.jsonc");
  const parent = pathToFileURL(path.join(applicationRoot, "package.json")).href;
  const resolve = (specifier) => fileURLToPath(resolveNativePublicEntry(specifier, parent));
  let main =
    input.adapter === "functions"
      ? path.join(applicationRoot, "src/ohmyhost/worker.ts")
      : input.adapter === "vite-static"
        ? path.join(applicationRoot, "src/ohmyhost/companion.ts")
        : input.adapter === "tanstack-start" && input.runtime === "edge"
          ? resolve("@tanstack/react-start/server-entry")
          : input.adapter === "astro" && input.runtime === "edge"
            ? resolve("@astrojs/cloudflare/entrypoints/server")
            : null;
  const privateEntries = [];
  const astroEdge = input.adapter === "astro" && input.runtime === "edge";
  if (
    input.adapter === "functions" ||
    (input.adapter === "vite-static" && input.runtime === "edge") ||
    astroEdge
  ) {
    const original = JSON.stringify(main);
    const entry = path.join(runtimeConfigRoot, "native-entry.mjs");
    const forwarded = astroEdge ? "||/^(?:forwarded$|x-forwarded-)/i.test(key)" : "";
    // Wrangler's dev proxy rewrites URL-valued request headers by hostname, including Origin.
    // Restore the agent's exact original value before customer CSRF checks and keep the URL
    // pinned to the accepted public origin. This entry is outside every served source root.
    fs.writeFileSync(
      entry,
      `import application from ${original};\nexport * from ${original};\nconst origin=${JSON.stringify(input.previewOrigin)};\nconst preserved=${JSON.stringify(ORIGINAL_BROWSER_HEADERS)};\nfunction requestForApplication(request){const url=new URL(request.url);const canonical=new URL(origin);url.protocol=canonical.protocol;url.host=canonical.host;const headers=new Headers(request.headers);const originals=preserved.map(([name,header])=>[name,headers.get(header)]);for(const key of [...headers.keys()])if(/^(?:mf-|x-mf-|x-ohmyhost-preview-)/i.test(key)${forwarded})headers.delete(key);for(const[name,value]of originals){headers.delete(name);if(value!==null)headers.set(name,atob(value));}return new Request(url, new Request(request,{headers}));}\nconst handler=typeof application==='function'?class extends application{fetch(request,...args){return super.fetch(requestForApplication(request),...args);}}:new Proxy(application,{get(target,key,receiver){if(key==='fetch')return(request,...args)=>target.fetch(requestForApplication(request),...args);return Reflect.get(target,key,receiver);}});\nexport default handler;\n`,
      { mode: 0o600, flag: "wx" },
    );
    main = entry;
    privateEntries.push(entry);
  }
  // Next uses a sourceless getPlatformProxy; its HTTP handler is next dev itself.
  const config = {
    name: `preview-app-${input.sessionId.toLowerCase()}`,
    ...(input.adapter === "nextjs" ? {} : { main }),
    compatibility_date: input.compatibilityDate,
    compatibility_flags: input.compatibilityFlags,
    services,
    vars: { ...input.environment, ...input.runtimeVariables },
    observability: { enabled: false },
    dev: {
      ip: "127.0.0.1",
      port: APPLICATION_PORT,
      local_protocol: "http",
      host: new URL(input.previewOrigin).host,
      upstream_protocol: "https",
    },
  };
  writeJson(configPath, config);
  // Next's platform proxy reads canonical config; the source is disposable and exact source
  // bytes remain in the immutable intake archive. Never retain customer provider bindings.
  for (const name of ["wrangler.json", "wrangler.jsonc", "wrangler.toml"]) {
    const file = path.join(applicationRoot, name);
    if (fs.existsSync(file)) {
      const target = path.join(applicationRoot, `.ohmyhost-preview-original-${name}`);
      if (fs.existsSync(target)) throw new Error("preview_reserved_config_exists");
      fs.renameSync(file, target);
    }
  }
  writeJson(path.join(applicationRoot, "wrangler.jsonc"), config);
  fs.chmodSync(path.join(applicationRoot, "wrangler.jsonc"), 0o644);
  const bridgeFile = path.join(here, "bindings-worker.mjs");
  if (!fs.existsSync(bridgeFile)) throw new Error("preview_capability_worker_missing");
  const bindingConfigPath = path.join(runtimeConfigRoot, "bindings.jsonc");
  writeJson(bindingConfigPath, {
    name: bindingName,
    main: bridgeFile,
    compatibility_date: "2026-08-21",
    compatibility_flags: ["nodejs_compat"],
    observability: { enabled: false },
    vars: { PREVIEW_SESSION_ID: input.sessionId },
    ...(multiWorker
      ? {
          services: [
            {
              binding: "PREVIEW_APPLICATION",
              service: `preview-app-${input.sessionId.toLowerCase()}`,
            },
          ],
        }
      : {}),
    dev: { ip: "127.0.0.1", port: BINDINGS_PORT, local_protocol: "http" },
  });
  const sourceRoot =
    repositoryRoot ??
    path.resolve(
      applicationRoot,
      ...Array(input.applicationRoot === "." ? 0 : input.applicationRoot.split("/").length).fill(
        "..",
      ),
    );
  const loader = prepareNativeLoader({
    applicationRoot,
    repositoryRoot: sourceRoot,
    runtimeConfigRoot,
    configPath,
    adapter: input.adapter,
    runtime: input.runtime,
    previewOrigin: input.previewOrigin,
  });
  if (input.adapter === "nextjs" && loader.hasOpenNext) {
    const nextConfigs = ["next.config.ts", "next.config.mjs", "next.config.js"].filter((name) =>
      fs.existsSync(path.join(applicationRoot, name)),
    );
    if (nextConfigs.length > 1) throw new Error("preview_next_config_ambiguous");
    const originalName = nextConfigs[0];
    const setup = `initOpenNextCloudflareForDev({configPath:${JSON.stringify(configPath)},persist:false,envFiles:[]})`;
    if (originalName) {
      const saved = `.ohmyhost-preview-original-${originalName}`;
      const originalPath = path.join(applicationRoot, originalName);
      const stat = fs.lstatSync(originalPath);
      if (!stat.isFile() || stat.nlink !== 1) throw new Error("preview_next_config_unsafe");
      const original = fs.readFileSync(originalPath, "utf8");
      fs.writeFileSync(path.join(applicationRoot, saved), original, { flag: "wx" });
      const manifest = JSON.parse(
        fs.readFileSync(path.join(applicationRoot, "package.json"), "utf8"),
      );
      const commonJs = originalName === "next.config.js" && manifest.type !== "module";
      const initialization = commonJs
        ? `\nconst __ohmyhost_preview_original_config__ = module.exports;\nmodule.exports = async (...args) => { const {initOpenNextCloudflareForDev} = await import("@opennextjs/cloudflare"); await ${setup}; return typeof __ohmyhost_preview_original_config__ === "function" ? __ohmyhost_preview_original_config__(...args) : __ohmyhost_preview_original_config__; };\n`
        : `\nimport { initOpenNextCloudflareForDev as __ohmyhost_preview_init__ } from "@opennextjs/cloudflare";\n${setup.replace("initOpenNextCloudflareForDev", "__ohmyhost_preview_init__")};\n`;
      const descriptor = fs.openSync(
        originalPath,
        fs.constants.O_WRONLY | fs.constants.O_TRUNC | fs.constants.O_NOFOLLOW,
      );
      try {
        fs.writeFileSync(descriptor, `${original}\n${initialization}`);
      } finally {
        fs.closeSync(descriptor);
      }
    } else {
      fs.writeFileSync(
        path.join(applicationRoot, "next.config.mjs"),
        `import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare";\n${setup};\nexport default {};\n`,
        { flag: "wx" },
      );
    }
  }
  return Object.freeze({
    configPath,
    bindingConfigPath,
    ...loader,
    privateFiles: Object.freeze([
      configPath,
      bindingConfigPath,
      ...privateEntries,
      ...loader.loaderFiles,
    ]),
  });
}

/** Installed security floors are rechecked before any framework config executes. */
export function nativeFrameworkCommands(input, applicationRoot, config) {
  if (input.adapter !== "functions")
    readFrameworkBuildArguments({
      applicationRoot,
      environment: { FRAMEWORK_ADAPTER: input.adapter, FRAMEWORK_RUNTIME: input.runtime },
    });
  const nodeImport = ["--import", config.loaderPath];
  const loaderEnvironment = {
    PREVIEW_NATIVE_CONFIG_PATH: config.configPath,
    PREVIEW_NATIVE_LOADER_MAP: config.loaderMapPath,
    NODE_OPTIONS: `--import=${JSON.stringify(config.loaderPath)}`,
  };
  const base = {
    ...input.runtimeVariables,
    ...loaderEnvironment,
    __VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS: new URL(input.previewOrigin).hostname,
    CLOUDFLARE_VITE_WRANGLER_CONFIG_PATH: config.configPath,
    WRANGLER_SEND_METRICS: "false",
    CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "false",
    NEXT_TELEMETRY_DISABLED: "1",
    ASTRO_TELEMETRY_DISABLED: "1",
  };
  const multiWorker =
    (input.adapter === "functions" ||
      (input.adapter === "vite-static" && input.runtime === "edge")) &&
    (input.capabilityBindings.database || input.capabilityBindings.auth);
  const localWorker = (configPath, port, multi = false) => ({
    file: "node",
    args: [
      ...nodeImport,
      "/opt/ohmyhost-platform/lib/node_modules/wrangler/bin/wrangler.js",
      "dev",
      "--local",
      "--ip",
      port === BINDINGS_PORT ? "127.0.0.1" : "0.0.0.0",
      "--port",
      String(port),
      "--config",
      multi ? config.bindingConfigPath : configPath,
      ...(multi ? ["--config", configPath] : []),
    ],
    environment: multi
      ? {
          ...loaderEnvironment,
          WRANGLER_SEND_METRICS: "false",
          CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "false",
        }
      : base,
  });
  const bindings =
    (input.capabilityBindings.database || input.capabilityBindings.auth) && !multiWorker
      ? {
          ...localWorker(config.bindingConfigPath, BINDINGS_PORT),
          environment: {
            ...loaderEnvironment,
            WRANGLER_SEND_METRICS: "false",
            CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "false",
          },
        }
      : null;
  if (input.adapter === "functions")
    return {
      bindings,
      multiWorker,
      application: localWorker(config.configPath, APPLICATION_PORT, multiWorker),
      companion: null,
    };
  if (input.adapter === "nextjs")
    return {
      bindings,
      application: {
        file: "node",
        args: [
          ...nodeImport,
          binary(applicationRoot, "next/dist/bin/next"),
          "dev",
          "--hostname",
          "0.0.0.0",
          "--port",
          String(APPLICATION_PORT),
        ],
        environment: base,
      },
      companion: null,
    };
  if (input.adapter === "astro")
    return {
      bindings,
      application: {
        file: "node",
        args: [
          ...nodeImport,
          packageBinary(applicationRoot, "astro", "astro"),
          "dev",
          "--host",
          "0.0.0.0",
          "--port",
          String(APPLICATION_PORT),
        ],
        environment: base,
      },
      companion: null,
    };
  const viteArgs = [
    ...nodeImport,
    binary(applicationRoot, "vite/bin/vite.js"),
    "--host",
    "0.0.0.0",
    "--port",
    String(APPLICATION_PORT),
    "--strictPort",
  ];
  return {
    bindings,
    multiWorker,
    application: { file: "node", args: viteArgs, environment: base },
    companion:
      input.adapter === "vite-static" && input.runtime === "edge"
        ? localWorker(config.configPath, COMPANION_PORT, multiWorker)
        : null,
  };
}
