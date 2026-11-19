import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { afterEach, test } from "node:test";
import { setImmediate } from "node:timers";
import { URL, fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

import {
  OPEN_NEXT_PATCHES,
  openNextPatchFiles,
  patchOpenNextPackage,
} from "../open-next-patch.mjs";

const temporaryDirectories = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

// The fixture installs the same @opennextjs/cloudflare 1.20.9 bytes as the build image.
const installed = fs.realpathSync(
  new URL("../../../../fixtures/next-edge/node_modules/@opennextjs/cloudflare", import.meta.url),
);

const ROUTING_HANDLER = OPEN_NEXT_PATCHES.findIndex(
  (patch) => patch.module === "@opennextjs/aws/core/routingHandler.js",
);

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Links the installed package except the selected files, which are safe writable copies. */
function linkAllBut(source, target, files) {
  fs.mkdirSync(target, { recursive: true });
  for (const name of fs.readdirSync(source)) {
    const selected = files.filter((file) => file === name || file.startsWith(`${name}/`));
    if (selected.length === 0) fs.symlinkSync(path.join(source, name), path.join(target, name));
    else if (selected.includes(name))
      fs.copyFileSync(path.join(source, name), path.join(target, name));
    else
      linkAllBut(
        path.join(source, name),
        path.join(target, name),
        selected.map((file) => file.slice(name.length + 1)),
      );
  }
}

/** A package root with copies of exactly the installed files the patch reads and writes. */
function installedCopy() {
  const directory = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "ohmyhost-open-next-patch-")),
  );
  temporaryDirectories.push(directory);
  // The copied plugins import @opennextjs/aws and their other dependencies from the installed
  // dependency directory; only the @opennextjs/aws file the patch rewrites is a copy.
  linkAllBut(
    path.dirname(path.dirname(installed)),
    path.join(directory, "node_modules"),
    OPEN_NEXT_PATCHES.filter((patch) => patch.module !== undefined).map((patch) =>
      patch.module.replace("@opennextjs/aws/", "@opennextjs/aws/dist/"),
    ),
  );
  const root = path.join(directory, "cloudflare");
  for (const patch of [{ file: "package.json" }, ...OPEN_NEXT_PATCHES])
    if (patch.file !== undefined) {
      fs.mkdirSync(path.dirname(path.join(root, patch.file)), { recursive: true });
      fs.copyFileSync(path.join(installed, patch.file), path.join(root, patch.file));
    }
  assert.ok(openNextPatchFiles(root).every((file) => file.startsWith(`${directory}${path.sep}`)));
  return root;
}

function contents(root) {
  return openNextPatchFiles(root).map((file) => fs.readFileSync(file, "utf8"));
}

test("patches the pinned OpenNext for Next.js 16.4 manifests and request-scoped module loading, and nothing else", async () => {
  assert.ok(
    OPEN_NEXT_PATCHES.some((patch) => patch.module === "@opennextjs/aws/adapters/cache.js"),
  );
  assert.ok(
    OPEN_NEXT_PATCHES.some(
      (patch) => patch.module === "@opennextjs/aws/adapters/composable-cache.js",
    ),
  );
  assert.ok(OPEN_NEXT_PATCHES.some((patch) => patch.module === "@opennextjs/aws/utils/promise.js"));
  const root = installedCopy();
  assert.deepEqual(patchOpenNextPackage(root), openNextPatchFiles(root));
  assert.deepEqual(
    [installed, root].map((packageRoot) =>
      openNextPatchFiles(packageRoot).map((file) => sha256(fs.readFileSync(file))),
    ),
    [
      OPEN_NEXT_PATCHES.map((patch) => patch.sourceSha256),
      OPEN_NEXT_PATCHES.map((patch) => patch.patchedSha256),
    ],
  );
  const [loadManifest] = contents(root);
  assert.ok(
    loadManifest.includes(
      'glob(join(dotNextDir, "**/{*-manifest,required-server-files,prefetch-hints,preview-props}.json")',
    ),
  );

  // Exercise the patched OpenNext handlers, including its catches: in the opt-in mode a failed
  // invalidation must reach the caller, while the established read-only behavior stays unchanged.
  const importAdapter = async (module) => {
    const bundled = await build({
      entryPoints: [createRequire(path.join(root, "package.json")).resolve(module)],
      bundle: true,
      format: "esm",
      platform: "node",
      write: false,
      logLevel: "silent",
    });
    return import(
      `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].contents).toString("base64")}`
    );
  };
  const { default: Cache } = await importAdapter("@opennextjs/aws/adapters/cache.js");
  const { default: composable } = await importAdapter(
    "@opennextjs/aws/adapters/composable-cache.js",
  );
  const { runWithOpenNextRequestContext } = await importAdapter("@opennextjs/aws/utils/promise.js");
  const old = {
    config: globalThis.openNextConfig,
    incremental: globalThis.incrementalCache,
    tags: globalThis.tagCache,
    als: globalThis.__openNextAls,
    error: globalThis.console.error,
    context: Object.getOwnPropertyDescriptor(globalThis, Symbol.for("__cloudflare-context__")),
    tracker: Object.getOwnPropertyDescriptor(
      globalThis,
      Symbol.for("ohmyhost.next.response-tasks/v1"),
    ),
  };
  try {
    globalThis.openNextConfig = { dangerous: {} };
    globalThis.__openNextAls = { getStore: () => ({ writtenTags: new Set() }) };
    globalThis.incrementalCache = {
      name: "ohmyhost-next-cache",
      get: async () => {
        throw new Error("cache unavailable");
      },
      set: async () => {
        throw new Error("cache unavailable");
      },
    };
    globalThis.tagCache = {
      mode: "nextMode",
      writeTags: async () => {
        throw new Error("invalidation unavailable");
      },
    };
    const cache = new Cache();
    await assert.rejects(cache.get("/page", {}), /cache unavailable/u);
    await assert.rejects(composable.get("item"), /cache unavailable/u);
    await assert.rejects(
      cache.writeCache("/page", { kind: "REDIRECT", props: {} }, {}),
      /cache unavailable/u,
    );
    await assert.rejects(cache.revalidateTag("_N_T_/page"), /invalidation unavailable/u);
    globalThis.incrementalCache.name = "read-only";
    globalThis.console.error = () => undefined;
    assert.equal(await cache.get("/page", {}), null);
    assert.equal(await composable.get("item"), undefined);
    await assert.doesNotReject(cache.revalidateTag("_N_T_/page"));
    globalThis.incrementalCache.name = "ohmyhost-next-cache";
    globalThis.__openNextAls = { getStore: () => undefined };
    await assert.rejects(cache.revalidateTag("_N_T_/page"), /request context/u);
    globalThis.__openNextAls = new AsyncLocalStorage();
    await assert.rejects(
      runWithOpenNextRequestContext({}, async () => {
        const writes = globalThis.__openNextAls
          .getStore()
          .requestCache.getOrCreate("ohmyhost-next-cache:pending-invalidations");
        const rejected = Promise.reject(new Error("deferred invalidation unavailable"));
        rejected.catch(() => undefined);
        writes.set("write", rejected);
        return new globalThis.Response("ok");
      }),
      /deferred invalidation unavailable/u,
    );
    const gate = Promise.withResolvers();
    const delayed = runWithOpenNextRequestContext({ waitUntil() {} }, async () => {
      const store = globalThis.__openNextAls.getStore();
      store.pendingPromiseRunner.add(
        gate.promise.then(() => {
          const writes = store.requestCache.getOrCreate(
            "ohmyhost-next-cache:pending-invalidations",
          );
          const rejected = Promise.reject(new Error("late invalidation unavailable"));
          rejected.catch(() => undefined);
          writes.set("late", rejected);
        }),
      );
      return new globalThis.Response("ok");
    });
    await new Promise((resolve) => setImmediate(resolve));
    gate.resolve();
    await assert.rejects(delayed, /late invalidation unavailable/u);
    const context = {};
    const tasks = new Set();
    Object.defineProperty(globalThis, Symbol.for("__cloudflare-context__"), {
      configurable: true,
      value: { ctx: context },
    });
    Object.defineProperty(globalThis, Symbol.for("ohmyhost.next.response-tasks/v1"), {
      configurable: true,
      value: new WeakMap([[context, tasks]]),
    });
    const task = runWithOpenNextRequestContext({}, async () => new globalThis.Response("ok"));
    await task;
    assert.equal(tasks.has(task), true);
  } finally {
    globalThis.openNextConfig = old.config;
    globalThis.incrementalCache = old.incremental;
    globalThis.tagCache = old.tags;
    globalThis.__openNextAls = old.als;
    globalThis.console.error = old.error;
    for (const [symbol, descriptor] of [
      [Symbol.for("__cloudflare-context__"), old.context],
      [Symbol.for("ohmyhost.next.response-tasks/v1"), old.tracker],
    ]) {
      if (descriptor === undefined) Reflect.deleteProperty(globalThis, symbol);
      else Object.defineProperty(globalThis, symbol, descriptor);
    }
  }

  // The fixture's Next.js 16.4.5 constructs CacheSignal(null) in this module, as 16.4.0 does.
  // Next.js 16.3.8 constructed CacheSignal() and the module is otherwise identical, so the 16.3
  // form is the fixture's module with that call replaced.
  const next164 = fs.readFileSync(
    new URL(
      "../../../../fixtures/next-edge/node_modules/next/dist/server/app-render/module-loading/track-module-loading.instance.js",
      import.meta.url,
    ),
    "utf8",
  );
  const next163 = next164.replace(
    "_moduleLoadingSignal = new _cachesignal.CacheSignal(null);",
    "_moduleLoadingSignal = new _cachesignal.CacheSignal();",
  );
  assert.notEqual(next163, next164, "the fixture installs a Next.js 16.4 module-loading source");
  const { patchCode } = await import(
    pathToFileURL(
      createRequire(path.join(installed, "package.json")).resolve(
        "@opennextjs/aws/build/patch/astCodePatcher.js",
      ),
    ).href
  );
  const plugin = (packageRoot) =>
    import(
      pathToFileURL(path.join(packageRoot, "dist/cli/build/patches/plugins/module-loading.js")).href
    );
  const { moduleLoadingSignalRule: shipped } = await plugin(installed);
  const { moduleLoadingSignalRule: patched } = await plugin(root);
  // The shipped rule silently keeps Next.js 16.4's signal shared by every request of an isolate.
  assert.equal(patchCode(next164, shipped), next164);
  // The patched rule scopes both forms to the request and keeps the 16.3 output byte for byte.
  assert.equal(patchCode(next163, patched), patchCode(next163, shipped));
  for (const [source, signalArguments] of [
    [next163, ""],
    [next164, "null"],
  ]) {
    const scoped = patchCode(source, patched);
    assert.ok(
      scoped.includes(
        `return requestStore.moduleLoadingSignal ??= new _cachesignal.CacheSignal(${signalArguments});`,
      ),
    );
    assert.ok(
      scoped.includes(
        `return _moduleLoadingSignal ??= new _cachesignal.CacheSignal(${signalArguments});`,
      ),
    );
  }

  // Patching twice, another version or other source bytes stops the image build and writes nothing.
  const patchedContents = contents(root);
  assert.throws(() => patchOpenNextPackage(root), /patch target occurs 0 times in /u);
  assert.deepEqual(contents(root), patchedContents);
  const otherVersion = installedCopy();
  const metadataPath = path.join(otherVersion, "package.json");
  const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
  fs.writeFileSync(metadataPath, JSON.stringify({ ...metadata, version: "1.20.10" }));
  assert.throws(
    () => patchOpenNextPackage(otherVersion),
    /requires @opennextjs\/cloudflare 1\.20\.9/u,
  );
  for (const [index, mutate, failure] of [
    [0, (source) => `${source}\n`, /differs from the reviewed /u],
    [
      1,
      (source) => `${source}\n// return $SIGNAL ??= new $CACHE_SIGNAL.CacheSignal();\n`,
      /occurs 2 times/u,
    ],
    [
      ROUTING_HANDLER,
      (source) => `${source}\n`,
      /differs from the reviewed @opennextjs\/aws\/core\/routingHandler\.js$/u,
    ],
  ]) {
    const changed = installedCopy();
    const file = openNextPatchFiles(changed)[index];
    fs.writeFileSync(file, mutate(fs.readFileSync(file, "utf8")));
    const before = contents(changed);
    assert.throws(() => patchOpenNextPackage(changed), failure);
    assert.deepEqual(contents(changed), before);
  }
});

test("makes OpenNext remove every internal request header the Next.js server removes", () => {
  const root = installedCopy();
  patchOpenNextPackage(root);
  const headers = (file, declaration) =>
    [
      ...new RegExp(`const ${declaration} = \\[([^\\]]*)\\]`, "u")
        .exec(fs.readFileSync(file, "utf8"))[1]
        .matchAll(/["']([^"']+)["']/gu),
    ].map(([, header]) => header);
  const next = headers(
    new URL(
      "../../../../fixtures/next-edge/node_modules/next/dist/server/lib/server-ipc/utils.js",
      import.meta.url,
    ),
    "INTERNAL_HEADERS",
  );
  const [shipped, patched] = [installed, root].map((packageRoot) =>
    headers(openNextPatchFiles(packageRoot)[ROUTING_HANDLER], "NEXT_INTERNAL_HEADERS"),
  );
  // OpenNext passes next-resume on, so a client could post its own postponed state to a page.
  assert.deepEqual(
    next.filter((header) => !shipped.includes(header)),
    ["next-resume"],
  );
  assert.deepEqual(patched, [...shipped, "next-resume"]);
});

test("the image command patches through a symlinked script path and fails a refused patch", () => {
  const root = installedCopy();
  const linked = path.join(path.dirname(root), "sandbox");
  fs.symlinkSync(fileURLToPath(new URL("..", import.meta.url)), linked);
  const run = () =>
    spawnSync(process.execPath, [path.join(linked, "open-next-patch.mjs"), root], {
      encoding: "utf8",
      env: { PATH: process.env.PATH },
    });
  const patched = run();
  assert.deepEqual([patched.status, patched.stdout, patched.stderr], [0, "", ""]);
  assert.deepEqual(
    openNextPatchFiles(root).map((file) => sha256(fs.readFileSync(file))),
    OPEN_NEXT_PATCHES.map((patch) => patch.patchedSha256),
  );
  const refused = run();
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /OpenNext patch target occurs 0 times in /u);
});
