import crypto from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";

// The build image applies reviewed fixes to the installed @opennextjs/cloudflare 1.20.9 and
// its @opennextjs/aws 4.1.8 so they run Next.js 16.4. Each target text must occur exactly once and
// both the source and the patched bytes are pinned, so any other OpenNext release or source byte
// stops the image build.
/**
 * A file of the package (file) or of a dependency resolved from it (module).
 * @typedef {Readonly<{
 *   sourceSha256: string,
 *   patchedSha256: string,
 *   replacements: readonly (readonly string[])[],
 * } & ({ file: string, module?: undefined } | { file?: undefined, module: string })>} OpenNextPatch
 */
/** @type {readonly OpenNextPatch[]} */
export const OPEN_NEXT_PATCHES = Object.freeze([
  Object.freeze({
    // Next.js 16.4 loads .next/server/preview-props.json when its server starts; OpenNext inlines
    // only the manifests this pattern names and throws for every other loadManifest call.
    file: "dist/cli/build/patches/plugins/load-manifest.js",
    sourceSha256: "d9b01ab939652e9c120da66dbbfc25c18b249b53258e4e21bcf59ac63412d700",
    patchedSha256: "06287c108cf324ab20494dc714e7eeadbd405661f54e01108c5fa2e079e46867",
    replacements: Object.freeze([
      Object.freeze([
        '"**/{*-manifest,required-server-files,prefetch-hints}.json"',
        '"**/{*-manifest,required-server-files,prefetch-hints,preview-props}.json"',
      ]),
    ]),
  }),
  Object.freeze({
    // Next.js 16.4 constructs its module-loading signal as CacheSignal(null). The rule that keeps
    // one signal per request matched only CacheSignal() and silently stopped applying; $$$ARGS
    // matches and keeps both forms, so Next.js 16.3.8 is patched exactly as before.
    file: "dist/cli/build/patches/plugins/module-loading.js",
    sourceSha256: "5f76050dcd1299e02fa26e802640695e4270301f3c7e202cab8ea18e6fdf4eec",
    patchedSha256: "7979fd652a293b56f216f3aec3fec47d1134e84a541db5dc30ec059acfaf1370",
    replacements: Object.freeze([
      Object.freeze([
        "pattern: $SIGNAL = new $CACHE_SIGNAL.CacheSignal()\n",
        "pattern: $SIGNAL = new $CACHE_SIGNAL.CacheSignal($$$ARGS)\n",
      ]),
      Object.freeze([
        "return requestStore.moduleLoadingSignal ??= new $CACHE_SIGNAL.CacheSignal();",
        "return requestStore.moduleLoadingSignal ??= new $CACHE_SIGNAL.CacheSignal($$$ARGS);",
      ]),
      Object.freeze([
        "return $SIGNAL ??= new $CACHE_SIGNAL.CacheSignal();",
        "return $SIGNAL ??= new $CACHE_SIGNAL.CacheSignal($$$ARGS);",
      ]),
    ]),
  }),
  Object.freeze({
    // OpenNext removes Next.js's internal request headers before routing, but its list predates
    // next-resume, which the Next.js server removes as well. Otherwise a client could post its own
    // postponed state to a Cache Components page, and Next.js inflates that up to five times the
    // postponed state limit.
    module: "@opennextjs/aws/core/routingHandler.js",
    sourceSha256: "c9884a6659bd9e98c75116a209df5078a7a794e8580dd4888556956363a41316",
    patchedSha256: "23ebf755599379f179c6c4c93b723bbda5599c9392793a21a1b94ce6972a022e",
    replacements: Object.freeze([
      Object.freeze([
        '    "x-next-resume-state-length",\n];',
        '    "x-next-resume-state-length",\n    "next-resume",\n];',
      ]),
    ]),
  }),
  Object.freeze({
    // Writable path revalidation must not report success after a cache RPC fails. The guard leaves
    // OpenNext's original best-effort behavior intact for the default read-only cache.
    module: "@opennextjs/aws/adapters/cache.js",
    sourceSha256: "f15972ddf9fefadb22d7b084eedc33522132d156f7090e276b120beb437fa714",
    patchedSha256: "11fab1e82902f3f10d4432740909319c4f77c998bb959bd8f43ff65c0a1be50c",
    replacements: Object.freeze([
      ...[
        'debug("Failed to get fetch cache", e);',
        'debug("Failed to get body cache", e);',
        'error("Failed to set cache", e);',
        'error("Failed to revalidate tag", e);',
      ].map((line) =>
        Object.freeze([
          `            ${line}`,
          `            if (globalThis.incrementalCache?.name === "ohmyhost-next-cache") throw e;\n            ${line}`,
        ]),
      ),
      Object.freeze([
        "        const _tags = Array.isArray(tags) ? tags : [tags];",
        '        if (globalThis.incrementalCache?.name === "ohmyhost-next-cache" && !globalThis.__openNextAls?.getStore()) throw new Error("Next cache request context is unavailable");\n        const _tags = Array.isArray(tags) ? tags : [tags];',
      ]),
    ]),
  }),
  Object.freeze({
    module: "@opennextjs/aws/adapters/composable-cache.js",
    sourceSha256: "75112f640a930a3da013cdccc0ba8f853cd6e1bcdaa4990618bf74ea6429004f",
    patchedSha256: "41d3e7d2a8bccef854ab9188bb53acf5722a86ba9b86a057c48c21f0e60db222",
    replacements: Object.freeze([
      Object.freeze([
        '            debug("Cannot read composable cache entry");',
        '            if (globalThis.incrementalCache?.name === "ohmyhost-next-cache") throw e;\n            debug("Cannot read composable cache entry");',
      ]),
    ]),
  }),
  Object.freeze({
    // Next can catch a revalidation rejection after scheduling it. Observe the original
    // request-local invalidation promises before the opted-in response leaves OpenNext.
    module: "@opennextjs/aws/utils/promise.js",
    sourceSha256: "3f4f822ac41fc5fc97f83043f03d5e9bde747e40e36b36d25b52992c95f5aaf8",
    patchedSha256: "60388e771e62b49026311adc3e1872b1f84409fd00505d011f4d05a7927a03f7",
    replacements: Object.freeze([
      Object.freeze([
        "    return globalThis.__openNextAls.run({",
        "    const task = globalThis.__openNextAls.run({",
      ]),
      Object.freeze([
        "        return result;\n    });\n}",
        '        if (globalThis.incrementalCache?.name === "ohmyhost-next-cache") {\n            const store = globalThis.__openNextAls.getStore();\n            await store?.pendingPromiseRunner.await();\n            const writes = store?.requestCache?.getOrCreate("ohmyhost-next-cache:pending-invalidations");\n            if (writes) await Promise.all(writes.values());\n        }\n        return result;\n    });\n    const context = globalThis[Symbol.for("__cloudflare-context__")]?.ctx;\n    const tasks = globalThis[Symbol.for("ohmyhost.next.response-tasks/v1")]?.get(context);\n    if (tasks) { task.catch(() => {}); tasks.add(task); }\n    return task;\n}',
      ]),
    ]),
  }),
]);

/** The installed files the fixes rewrite; a dependency resolves as OpenNext's own build finds it. */
export function openNextPatchFiles(packageRoot) {
  const packageRequire = createRequire(path.join(packageRoot, "package.json"));
  return OPEN_NEXT_PATCHES.map((patch) =>
    patch.module === undefined
      ? path.join(packageRoot, patch.file)
      : packageRequire.resolve(patch.module),
  );
}

function sha256(text) {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

/** The reviewed bytes of one patched file; any other source throws before anything is written. */
function patchedSource(patch, source) {
  const name = patch.file ?? patch.module;
  let patched = source;
  for (const [target, replacement] of patch.replacements) {
    // Split and join: a replacement string would read `$$` in "$$$ARGS" as an escaped `$`.
    const parts = patched.split(target);
    if (parts.length !== 2)
      throw new Error(`OpenNext patch target occurs ${String(parts.length - 1)} times in ${name}`);
    patched = parts.join(replacement);
  }
  if (sha256(source) !== patch.sourceSha256 || sha256(patched) !== patch.patchedSha256)
    throw new Error(`OpenNext patch source differs from the reviewed ${name}`);
  return patched;
}

/** Applies every reviewed fix to the installed package and returns the rewritten files. */
export function patchOpenNextPackage(packageRoot) {
  const metadata = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"));
  if (metadata?.name !== "@opennextjs/cloudflare" || metadata.version !== "1.20.9")
    throw new Error("OpenNext patch requires @opennextjs/cloudflare 1.20.9");
  // Every file is checked before the first write, so a refused patch leaves the package unchanged.
  const files = openNextPatchFiles(packageRoot).map((file, index) => [
    file,
    patchedSource(OPEN_NEXT_PATCHES[index], fs.readFileSync(file, "utf8")),
  ]);
  for (const [file, patched] of files) fs.writeFileSync(file, patched);
  return files.map(([file]) => file);
}

// The image build runs this module, also through a linked path; importing it patches nothing.
if (import.meta.main) patchOpenNextPackage(process.argv[2]);
