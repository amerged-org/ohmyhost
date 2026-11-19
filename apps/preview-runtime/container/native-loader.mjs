import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { Buffer } from "node:buffer";
import { createRequire, registerHooks } from "node:module";
import { fileURLToPath, pathToFileURL, URL } from "node:url";

const SCHEMA = "ohmyhost.native-loader/v1";
const ORIGINAL = "ohmyhost-native-original";
const LOADER = fileURLToPath(import.meta.url);

function invalid() {
  throw new Error("preview_native_loader_invalid");
}

/** Resolve the actual public ESM export without importing or evaluating customer dependencies. */
export function resolveNativePublicEntry(specifier, parent) {
  const virtual = "ohmyhost:resolve-public-entry";
  const hooks = registerHooks({
    resolve(value, context, nextResolve) {
      return value === virtual
        ? nextResolve(specifier, { ...context, parentURL: parent })
        : nextResolve(value, context);
    },
  });
  try {
    return import.meta.resolve(virtual);
  } finally {
    hooks.deregister();
  }
}

function checkedEntry(url, repositoryRoot) {
  const value = new URL(url);
  if (value.protocol !== "file:" || value.search || value.hash) return invalid();
  const filename = fs.realpathSync(fileURLToPath(value));
  const relative = path.relative(repositoryRoot, filename);
  if (
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative) ||
    !fs.statSync(filename).isFile()
  )
    return invalid();
  return pathToFileURL(filename).href;
}

function originalURL(url) {
  const value = new URL(url);
  value.searchParams.set(ORIGINAL, "1");
  return value.href;
}

function shimSource(kind, entry) {
  const original = JSON.stringify(originalURL(entry));
  const configuration = `const configPath = process.env.PREVIEW_NATIVE_CONFIG_PATH;\nif (!configPath) throw new Error("preview_native_configuration_missing");\n`;
  if (kind === "cloudflare")
    return `import process from "node:process";\nexport * from ${original};\nimport { cloudflare as factory } from ${original};\n${configuration}export function cloudflare(options, ...rest) { return Reflect.apply(factory, this, [{...options,configPath},...rest]); }\n`;
  if (kind === "astro")
    return `import process from "node:process";\nexport * from ${original};\nimport factory from ${original};\n${configuration}export default function cloudflare(options, ...rest) { return Reflect.apply(factory, this, [{...options,configPath},...rest]); }\n`;
  return `import process from "node:process";\nexport * from ${original};\nimport { initOpenNextCloudflareForDev as initialize } from ${original};\n${configuration}const registryKey=Symbol.for("ohmyhost.native.open-next.initialization/v1");\nexport function initOpenNextCloudflareForDev(options) {\n  const selected = {...options,configPath,envFiles:[]};\n  // OpenNext skips the CLI's first process before Next installs AsyncLocalStorage.\n  if (!globalThis.AsyncLocalStorage) return initialize(selected);\n  // Next can compile this same shim through its CJS config hook and later import it as ESM.\n  // A process-owned registry prevents those two module caches initializing competing contexts.\n  const registry = globalThis[registryKey] ??= new Map();\n  let initialized = registry.get(configPath);\n  if (!initialized) { initialized = Promise.resolve().then(() => initialize(selected)); registry.set(configPath,initialized); }\n  return initialized;\n}\n`;
}

/** Private shims contain paths and wrappers only; runtime variable values stay in the private config. */
export function prepareNativeLoader({
  applicationRoot,
  repositoryRoot = applicationRoot,
  runtimeConfigRoot,
  configPath,
  adapter,
  runtime,
  previewOrigin,
}) {
  repositoryRoot = fs.realpathSync(repositoryRoot);
  const parent = pathToFileURL(path.join(applicationRoot, "package.json")).href;
  const require = createRequire(parent);
  const targets = new Map();
  const add = (kind, entry, shimEntry = entry) => {
    const url = checkedEntry(entry, repositoryRoot);
    const original = checkedEntry(shimEntry, repositoryRoot);
    targets.set(url, { kind, original });
  };
  let cloudflareFound = false;
  try {
    add("cloudflare", resolveNativePublicEntry("@cloudflare/vite-plugin", parent));
    cloudflareFound = true;
  } catch {
    /* Astro may own this dependency transitively instead of declaring it on the app. */
  }
  if (adapter === "astro" && runtime === "edge") {
    const astro = checkedEntry(
      pathToFileURL(require.resolve("@astrojs/cloudflare")).href,
      repositoryRoot,
    );
    add("astro", astro);
    add("cloudflare", resolveNativePublicEntry("@cloudflare/vite-plugin", astro));
    cloudflareFound = true;
  }
  if (adapter === "tanstack-start" && runtime === "edge" && !cloudflareFound) return invalid();
  let hasOpenNext = false;
  let nextRequest;
  if (adapter === "nextjs") {
    if (fs.existsSync(path.join(applicationRoot, "node_modules/next/package.json"))) {
      const origin = new URL(previewOrigin);
      if (origin.protocol !== "https:" || origin.origin !== previewOrigin) return invalid();
      nextRequest = {
        origin: previewOrigin,
        configUrl: checkedEntry(
          pathToFileURL(path.join(applicationRoot, "node_modules/next/dist/server/config.js")).href,
          repositoryRoot,
        ),
        url: checkedEntry(
          pathToFileURL(path.join(applicationRoot, "node_modules/next/dist/server/next-server.js"))
            .href,
          repositoryRoot,
        ),
      };
    }
    let entry;
    try {
      entry = resolveNativePublicEntry("@opennextjs/cloudflare", parent);
    } catch {
      /* A plain Next.js app need not install the optional bindings SDK. */
    }
    if (entry !== undefined) {
      add("next", entry);
      hasOpenNext = true;
      try {
        add(
          "next",
          resolveNativePublicEntry("@opennextjs/cloudflare/cloudflare-context", parent),
          entry,
        );
      } catch {
        /* A future public root may contain the implementation without this optional subpath. */
      }
    }
  }
  const files = [];
  const entries = [];
  const shims = new Map();
  for (const [url, target] of targets) {
    const identity = `${target.kind}:${target.original}`;
    let shim = shims.get(identity);
    if (shim === undefined) {
      const filename = path.join(runtimeConfigRoot, `native-${target.kind}-${shims.size}.mjs`);
      fs.writeFileSync(filename, shimSource(target.kind, target.original), {
        flag: "wx",
        mode: 0o600,
      });
      files.push(filename);
      shim = pathToFileURL(filename).href;
      shims.set(identity, shim);
    }
    entries.push({ url, shim });
  }
  const mapPath = path.join(runtimeConfigRoot, "native-map.json");
  fs.writeFileSync(
    mapPath,
    JSON.stringify({
      schemaVersion: SCHEMA,
      configPath,
      entries,
      ...(nextRequest === undefined ? {} : { nextRequest }),
    }),
    {
      flag: "wx",
      mode: 0o600,
    },
  );
  files.push(mapPath);
  return Object.freeze({
    loaderPath: LOADER,
    loaderMapPath: mapPath,
    loaderFiles: Object.freeze(files),
    hasOpenNext,
  });
}

/** Exact public entry URLs catch both bare imports and Vite's bundled absolute file-URL imports. */
export function installNativeLoader(mapPath, configurationPath) {
  const map = JSON.parse(fs.readFileSync(mapPath, "utf8"));
  if (
    !map ||
    map.schemaVersion !== SCHEMA ||
    map.configPath !== configurationPath ||
    !path.isAbsolute(configurationPath) ||
    !Array.isArray(map.entries) ||
    map.entries.length > 16
  )
    return invalid();
  const entries = new Map();
  const nextRequest = map.nextRequest;
  if (
    nextRequest !== undefined &&
    (!nextRequest ||
      typeof nextRequest.configUrl !== "string" ||
      new URL(nextRequest.configUrl).protocol !== "file:" ||
      typeof nextRequest.url !== "string" ||
      new URL(nextRequest.url).protocol !== "file:" ||
      typeof nextRequest.origin !== "string" ||
      new URL(nextRequest.origin).protocol !== "https:" ||
      new URL(nextRequest.origin).origin !== nextRequest.origin)
  )
    return invalid();
  const originalCjsParents = new Set();
  for (const entry of map.entries) {
    if (!entry || typeof entry.url !== "string" || typeof entry.shim !== "string") return invalid();
    for (const value of [entry.url, entry.shim])
      if (new URL(value).protocol !== "file:") return invalid();
    if (entries.has(entry.url)) return invalid();
    entries.set(entry.url, entry.shim);
  }
  return registerHooks({
    load(url, context, nextLoad) {
      const loaded = nextLoad(url, context);
      if (nextRequest === undefined || (url !== nextRequest.url && url !== nextRequest.configUrl))
        return loaded;
      // The synchronous CommonJS loader leaves format undefined on Node 24.6.
      if (loaded.format !== undefined && loaded.format !== "commonjs") return invalid();
      const source = loaded.source ?? fs.readFileSync(fileURLToPath(url));
      // Next uses the listening hostname for initURL even behind trusted forwarded headers.
      // Keep its transport, body clone and query metadata; only the public URL is canonical.
      const patch =
        url === nextRequest.configUrl
          ? // Let Next evaluate objects, promises and phase/config functions in its native module path.
            // Only the disposable dev configuration gains this exact trusted lease hostname.
            `\n;{const original=module.exports.default;if(typeof original!=='function')throw new Error('preview_next_config_contract_changed');const hostname=${JSON.stringify(new URL(nextRequest.origin).hostname)};const selected=async function(...args){const configuration=await Reflect.apply(original,this,args);if(!configuration||typeof configuration!=='object'||(configuration.allowedDevOrigins!==undefined&&!Array.isArray(configuration.allowedDevOrigins)))throw new Error('preview_next_config_contract_changed');return {...configuration,allowedDevOrigins:[...new Set([...(configuration.allowedDevOrigins??[]),hostname])]};};module.exports=new Proxy(module.exports,{get(target,key,receiver){return key==='default'?selected:Reflect.get(target,key,receiver);}}); }\n`
          : `\n;{const prototype=module.exports.default?.prototype;const original=prototype?.attachRequestMeta;if(typeof original!=='function')throw new Error('preview_next_request_contract_changed');const origin=${JSON.stringify(nextRequest.origin)};prototype.attachRequestMeta=function(request,...args){const result=Reflect.apply(original,this,[request,...args]);const metadata=request[Symbol.for('NextInternalRequestMeta')];if(!metadata||typeof metadata.initURL!=='string'||typeof request.url!=='string')throw new Error('preview_next_request_contract_changed');const url=new URL(request.url,origin);const canonical=new URL(origin);url.protocol=canonical.protocol;url.host=canonical.host;metadata.initURL=url.href;metadata.initProtocol=canonical.protocol.slice(0,-1);return result;};}\n`;
      return {
        ...loaded,
        source: `${typeof source === "string" ? source : Buffer.from(source).toString("utf8")}${patch}`,
      };
    },
    resolve(specifier, context, nextResolve) {
      const commonjs = new Set(context.conditions).has("require");
      let requestedOriginal = false;
      let selectedSpecifier = specifier;
      if (commonjs && specifier.startsWith("file:")) {
        const requested = new URL(specifier);
        requestedOriginal = requested.searchParams.get(ORIGINAL) === "1";
        // Next's SWC require hook can compile a shim's static ESM imports into require(file:).
        // CommonJS needs the path before its FIRST resolver call; preserve the original marker here.
        selectedSpecifier = fileURLToPath(requested);
      }
      const resolved = nextResolve(selectedSpecifier, context);
      if (!resolved.url.startsWith("file:")) return resolved;
      const url = new URL(resolved.url);
      const bypass = requestedOriginal || url.searchParams.get(ORIGINAL) === "1";
      url.search = "";
      url.hash = "";
      const shim = entries.get(url.href);
      if (shim === undefined) return resolved;
      if (bypass) {
        if (commonjs) originalCjsParents.add(url.href);
        return resolved;
      }
      // A public re-export inside the original OpenNext graph must stay original too.
      if (context.parentURL) {
        const parent = new URL(context.parentURL);
        const markedParent = parent.searchParams.get(ORIGINAL) === "1";
        parent.search = "";
        parent.hash = "";
        if (
          (markedParent || originalCjsParents.has(parent.href)) &&
          entries.get(parent.href) === shim
        ) {
          if (commonjs) {
            originalCjsParents.add(url.href);
            return resolved;
          }
          return nextResolve(originalURL(resolved.url), context);
        }
      }
      // Node's synchronous CommonJS resolver accepts a filesystem path here, not a file: URL.
      // Both forms canonicalize to the same ESM shim, preserving one Next initializer instance.
      return nextResolve(commonjs ? fileURLToPath(shim) : shim, context);
    },
  });
}

if (process.env.PREVIEW_NATIVE_LOADER_MAP)
  installNativeLoader(
    process.env.PREVIEW_NATIVE_LOADER_MAP,
    process.env.PREVIEW_NATIVE_CONFIG_PATH,
  );
